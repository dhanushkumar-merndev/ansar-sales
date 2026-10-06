-- Role-based Telegram notifications on top of the telegram_notifications queue.
--
-- Instant events (never sent to the person who acted):
--   lead_created → admins · lead_assigned → new owner · lead_closed (won/lost) → admins
--   follow_up_changed (someone else scheduled/rescheduled your task) → assignee
--   expense_added / capital_added → admin + account · library_file_added → admin + sales
-- Repeating: overdue_nag every 5 minutes, 09:00–21:00 IST, until the follow-up is completed,
--   cancelled, rescheduled, or silenced from the Telegram button.
-- Digests: digest_sales 09:00 IST · digest_admin 20:00 IST · digest_finance 1st of month 09:00 IST.
-- Users can switch each kind off; delivery rechecks role, preference and lead access.

-- ---------------------------------------------------------------------------
-- Queue changes
-- ---------------------------------------------------------------------------
alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check check (kind in (
  'recurring_expense', 'lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
  'expense_added', 'capital_added', 'library_file_added', 'digest_sales', 'digest_admin', 'digest_finance', 'test'));

alter table public.telegram_notifications
  add column lead_id uuid references public.leads (id) on delete cascade,
  add column follow_up_id uuid references public.follow_ups (id) on delete cascade;

create index telegram_notifications_follow_up_idx on public.telegram_notifications (follow_up_id)
  where follow_up_id is not null and state in ('pending', 'processing');

-- Which kinds each role may receive. The single source of truth for routing and preferences.
create function private.notification_kinds_for(p_role public.app_role)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_role
    when 'admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'test']
    when 'sales' then array['lead_assigned', 'follow_up_changed', 'overdue_nag', 'library_file_added', 'digest_sales', 'test']
    when 'account' then array['expense_added', 'capital_added', 'recurring_expense', 'digest_finance', 'test']
    else array[]::text[] end
$$;

-- ---------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------
create table public.notification_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  disabled_kinds text[] not null default '{}',
  updated_at timestamptz not null default now()
);

alter table public.notification_settings enable row level security;
create policy notification_settings_select on public.notification_settings for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.notification_settings from anon, authenticated;
grant select on public.notification_settings to authenticated;

create function public.set_notification_pref(p_kind text, p_enabled boolean)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_disabled text[];
begin
  if v_role is null then
    perform private.raise_forbidden();
  end if;
  if p_kind is null or p_kind = 'test' or not (p_kind = any(private.notification_kinds_for(v_role))) then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  insert into public.notification_settings as s (user_id, disabled_kinds)
  values ((select auth.uid()), case when p_enabled then '{}'::text[] else array[p_kind] end)
  on conflict (user_id) do update set
    disabled_kinds = case when p_enabled then array_remove(s.disabled_kinds, p_kind)
                          when p_kind = any(s.disabled_kinds) then s.disabled_kinds
                          else s.disabled_kinds || p_kind end,
    updated_at = now()
  returning disabled_kinds into v_disabled;
  return v_disabled;
end $$;

-- ---------------------------------------------------------------------------
-- Enqueue helpers
-- ---------------------------------------------------------------------------
-- Queues one message unless the recipient acted, is inactive, may not receive the kind,
-- switched it off, or has no connected Telegram. Returns whether a row was queued.
create function private.enqueue_notification(
  p_recipient uuid, p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null, p_follow_up_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_recipient is null or p_recipient = p_actor then
    return false;
  end if;
  insert into public.telegram_notifications (recipient_id, kind, payload, dedupe_key, lead_id, follow_up_id)
  select p.id, p_kind, p_payload, p_dedupe, p_lead_id, p_follow_up_id
  from public.profiles p
  join public.telegram_connections t on t.user_id = p.id and t.status = 'connected'
  left join public.notification_settings s on s.user_id = p.id
  where p.id = p_recipient and p.is_active
    and p_kind = any(private.notification_kinds_for(p.role))
    and not (p_kind = any(coalesce(s.disabled_kinds, '{}')))
  on conflict do nothing;
  return found;
end $$;

create function private.enqueue_for_roles(
  p_roles public.app_role[], p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in select p.id from public.profiles p where p.is_active and p.role = any(p_roles) loop
    if private.enqueue_notification(r.id, p_kind, p_payload, p_dedupe, p_actor, p_lead_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Instant event triggers
-- ---------------------------------------------------------------------------
create function private.notify_lead_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
  v_fu public.follow_ups%rowtype;
  v_base jsonb;
begin
  if new.type::text not in ('lead_created', 'status_changed', 'assigned', 'follow_up_scheduled', 'follow_up_rescheduled') then
    return null;
  end if;
  select * into v_lead from public.leads l where l.id = new.lead_id;
  if not found or v_lead.archived_at is not null then
    return null;
  end if;
  v_base := jsonb_build_object(
    'lead_id', v_lead.id, 'lead_name', v_lead.name, 'actor', private.display_name(new.actor_id),
    'owner', private.display_name(v_lead.owner_id),
    'niche', (select n.name from public.niches n where n.id = v_lead.niche_id));

  if new.type = 'lead_created' then
    perform private.enqueue_for_roles(array['admin']::public.app_role[], 'lead_created',
      v_base || jsonb_build_object('status', v_lead.status), 'lead_created:' || v_lead.id, new.actor_id, v_lead.id);
    -- Created by someone else on the owner's behalf.
    perform private.enqueue_notification(v_lead.owner_id, 'lead_assigned',
      v_base || jsonb_build_object('phone', v_lead.phone), 'lead_assigned:' || new.id, new.actor_id, v_lead.id);
  elsif new.type = 'assigned' then
    perform private.enqueue_notification(v_lead.owner_id, 'lead_assigned',
      v_base || jsonb_build_object('phone', v_lead.phone, 'from', new.meta ->> 'from'), 'lead_assigned:' || new.id,
      new.actor_id, v_lead.id);
  elsif new.type = 'status_changed' then
    if new.meta ->> 'to' in ('won', 'lost') then
      perform private.enqueue_for_roles(array['admin']::public.app_role[], 'lead_closed',
        v_base || jsonb_build_object('status', new.meta ->> 'to'), 'lead_closed:' || new.id, new.actor_id, v_lead.id);
    end if;
  else
    select * into v_fu from public.follow_ups f where f.id = new.follow_up_id;
    if found and v_fu.state = 'pending' then
      perform private.enqueue_notification(v_fu.assignee_id, 'follow_up_changed',
        v_base || jsonb_build_object('follow_up_id', v_fu.id, 'task', v_fu.task, 'due_at', v_fu.due_at,
          'rescheduled', new.type = 'follow_up_rescheduled'),
        'follow_up_changed:' || new.id, new.actor_id, v_lead.id, v_fu.id);
    end if;
  end if;
  return null;
end $$;

create trigger lead_activities_notify after insert on public.lead_activities
  for each row execute function private.notify_lead_activity();

create function private.notify_finance_entry()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'expenses' then
    -- Recurring expenses already send their own 'recurring_expense' notice.
    if new.recurrence_id is not null then
      return null;
    end if;
    perform private.enqueue_for_roles(array['admin', 'account']::public.app_role[], 'expense_added',
      jsonb_build_object('id', new.id, 'date', new.expense_date, 'category', new.category, 'amount', new.amount,
        'item', new.item, 'quantity', new.quantity, 'payment_mode', new.payment_mode, 'description', new.description,
        'actor', private.display_name(new.created_by)),
      'expense_added:' || new.id, new.created_by);
  else
    perform private.enqueue_for_roles(array['admin', 'account']::public.app_role[], 'capital_added',
      jsonb_build_object('id', new.id, 'date', new.entry_date, 'contributor', new.contributor, 'amount', new.amount,
        'item', new.item, 'quantity', new.quantity, 'payment_mode', new.payment_mode, 'description', new.description,
        'actor', private.display_name(new.created_by)),
      'capital_added:' || new.id, new.created_by);
  end if;
  return null;
end $$;

create trigger expenses_notify after insert on public.expenses
  for each row execute function private.notify_finance_entry();
create trigger capital_entries_notify after insert on public.capital_entries
  for each row execute function private.notify_finance_entry();

create function private.notify_library_file()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_for_roles(array['admin', 'sales']::public.app_role[], 'library_file_added',
    jsonb_build_object('id', new.id, 'name', new.name, 'folder_id', new.folder_id,
      'folder', (select f.name from public.library_folders f where f.id = new.folder_id),
      'actor', private.display_name(new.created_by)),
    'library_file_added:' || new.id, new.created_by);
  return null;
end $$;

create trigger library_files_notify after insert on public.library_files
  for each row execute function private.notify_library_file();

-- ---------------------------------------------------------------------------
-- Overdue alerts
-- ---------------------------------------------------------------------------
-- A silence applies to one follow-up revision, so rescheduling re-arms the alerts.
create table public.follow_up_nag_silences (
  follow_up_id uuid not null references public.follow_ups (id) on delete cascade,
  revision integer not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  silenced_at timestamptz not null default now(),
  primary key (follow_up_id, revision)
);
alter table public.follow_up_nag_silences enable row level security;
revoke all on public.follow_up_nag_silences from anon, authenticated;

-- Every 5 minutes, 09:00–21:00 IST: one alert per overdue follow-up (at most 20 per user per run).
-- Skips follow-ups that are silenced or still have an undelivered alert (no backlog after outages).
create function private.enqueue_overdue_nags(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_hour integer := extract(hour from p_now at time zone 'Asia/Kolkata');
  v_bucket bigint := floor(extract(epoch from p_now) / 300);
  v_count integer := 0;
  r record;
begin
  if v_hour < 9 or v_hour >= 21 then
    return 0;
  end if;
  for r in
    select x.* from (
      select f.id, f.revision, f.task, f.due_at, f.assignee_id, l.id as lead_id, l.name as lead_name, l.phone,
        row_number() over (partition by f.assignee_id order by f.due_at, f.id) as rn
      from public.follow_ups f
      join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.state = 'pending' and f.due_at < p_now - interval '5 minutes'
        and not exists (select 1 from public.follow_up_nag_silences s where s.follow_up_id = f.id and s.revision = f.revision)
        and not exists (select 1 from public.telegram_notifications n
          where n.follow_up_id = f.id and n.kind = 'overdue_nag' and n.state in ('pending', 'processing'))
    ) x
    where x.rn <= 20
  loop
    if private.enqueue_notification(r.assignee_id, 'overdue_nag',
      jsonb_build_object('lead_id', r.lead_id, 'lead_name', r.lead_name, 'phone', r.phone, 'follow_up_id', r.id,
        'revision', r.revision, 'task', r.task, 'due_at', r.due_at),
      'overdue:' || r.id || ':' || r.revision || ':' || v_bucket, null, r.lead_id, r.id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- Called by the Telegram webhook (service role) when the 🔕 button is pressed. The chat must
-- belong to the follow-up's current assignee.
create function public.silence_follow_up_nag(p_chat_id bigint, p_follow_up_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_fu record;
begin
  select t.user_id into v_user
  from public.telegram_connections t
  join public.profiles p on p.id = t.user_id and p.is_active
  where t.chat_id = p_chat_id and t.status = 'connected';
  if v_user is null then
    return jsonb_build_object('ok', false);
  end if;
  select f.id, f.revision, f.assignee_id, f.state, l.name as lead_name into v_fu
  from public.follow_ups f join public.leads l on l.id = f.lead_id
  where f.id = p_follow_up_id;
  if not found or v_fu.assignee_id <> v_user then
    return jsonb_build_object('ok', false);
  end if;
  insert into public.follow_up_nag_silences (follow_up_id, revision, user_id)
  values (v_fu.id, v_fu.revision, v_user)
  on conflict do nothing;
  update public.telegram_notifications n set state = 'cancelled', last_error = 'silenced', lease_token = null
    where n.follow_up_id = v_fu.id and n.kind = 'overdue_nag' and n.state = 'pending';
  return jsonb_build_object('ok', true, 'lead_name', v_fu.lead_name);
end $$;

-- ---------------------------------------------------------------------------
-- Digests (cron every 15 minutes; each digest is queued once per day/month by its dedupe key).
-- The windows allow catching up if a run is missed.
-- ---------------------------------------------------------------------------
create function private.enqueue_digests(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_day date := v_local::date;
  v_hour integer := extract(hour from v_local);
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_day_end timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_month_start date := date_trunc('month', v_day)::date;
  v_prev_month date := (date_trunc('month', v_day) - interval '1 month')::date;
  v_count integer := 0;
  v_today integer;
  v_overdue integer;
  v_tasks jsonb;
  v_rows jsonb;
  v_payload jsonb;
  r record;
begin
  -- Sales (and admins who own tasks): today's tasks and overdue count, 09:00–11:59 IST.
  if v_hour between 9 and 11 then
    for r in select p.id from public.profiles p where p.is_active and p.role in ('sales', 'admin') loop
      select count(*) filter (where f.due_at >= v_day_start and f.due_at < v_day_end),
             count(*) filter (where f.due_at < p_now)
        into v_today, v_overdue
      from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.assignee_id = r.id and f.state = 'pending';
      continue when v_today + v_overdue = 0;
      select coalesce(jsonb_agg(t order by t.due_at, t.id), '[]'::jsonb) into v_tasks from (
        select f.id, f.task, f.due_at, l.id as lead_id, l.name as lead_name, f.due_at < p_now as overdue
        from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where f.assignee_id = r.id and f.state = 'pending' and f.due_at < v_day_end
        order by f.due_at, f.id limit 10
      ) t;
      if private.enqueue_notification(r.id, 'digest_sales',
        jsonb_build_object('date', v_day, 'today', v_today, 'overdue', v_overdue, 'tasks', v_tasks),
        'digest_sales:' || v_day) then
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  -- Admin team report, 20:00–22:59 IST.
  if v_hour between 20 and 22 then
    select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) into v_rows from (
      select p.display_name as name,
        (select count(*) from public.leads l where l.owner_id = p.id and l.archived_at is null
           and l.status not in ('won', 'lost')) as active,
        (select count(*) from public.leads l where l.owner_id = p.id
           and l.created_at >= v_day_start and l.created_at < v_day_end) as new_today,
        (select count(*) from public.follow_ups f where f.assignee_id = p.id and f.state = 'completed'
           and f.completed_at >= v_day_start and f.completed_at < v_day_end) as done_today,
        (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
           where f.assignee_id = p.id and f.state = 'pending' and f.due_at < p_now) as overdue,
        (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id
           where l.owner_id = p.id and a.type = 'status_changed' and a.meta ->> 'to' = 'won'
             and a.created_at >= v_day_start and a.created_at < v_day_end) as won_today,
        (select count(*) from public.lead_activities a where a.actor_id = p.id
           and a.created_at >= v_day_start and a.created_at < v_day_end) as actions_today,
        (select max(a.created_at) from public.lead_activities a where a.actor_id = p.id) as last_activity
      from public.profiles p
      where p.is_active and p.role = 'sales'
    ) x;
    v_count := v_count + private.enqueue_for_roles(array['admin']::public.app_role[], 'digest_admin',
      jsonb_build_object('date', v_day, 'rows', v_rows), 'digest_admin:' || v_day);
  end if;

  -- Monthly finance summary for the previous month, 1st of the month 09:00–11:59 IST.
  if extract(day from v_local) = 1 and v_hour between 9 and 11 then
    select jsonb_build_object(
      'month', to_char(v_prev_month, 'YYYY-MM'),
      'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.archived_at is null
        and e.expense_date >= v_prev_month and e.expense_date < v_month_start), 0),
      'expense_count', (select count(*) from public.expenses e where e.archived_at is null
        and e.expense_date >= v_prev_month and e.expense_date < v_month_start),
      'categories', coalesce((select jsonb_agg(c order by c.total desc) from (
        select e.category, sum(e.amount) as total from public.expenses e
        where e.archived_at is null and e.expense_date >= v_prev_month and e.expense_date < v_month_start
        group by e.category) c), '[]'::jsonb),
      'capital_total', coalesce((select sum(c.amount) from public.capital_entries c where c.archived_at is null
        and c.entry_date >= v_prev_month and c.entry_date < v_month_start), 0)
    ) into v_payload;
    v_count := v_count + private.enqueue_for_roles(array['admin', 'account']::public.app_role[], 'digest_finance',
      v_payload, 'digest_finance:' || to_char(v_prev_month, 'YYYY-MM'));
  end if;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Test message
-- ---------------------------------------------------------------------------
create function public.send_test_notification()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.telegram_connections t where t.user_id = v_uid and t.status = 'connected') then
    raise exception 'telegram_not_connected' using errcode = '22023';
  end if;
  if exists (select 1 from public.telegram_notifications n where n.recipient_id = v_uid and n.kind = 'test'
             and n.created_at > now() - interval '30 seconds') then
    raise exception 'test_too_soon' using errcode = '22023';
  end if;
  perform private.enqueue_notification(v_uid, 'test',
    jsonb_build_object('name', private.display_name(v_uid)), 'test:' || gen_random_uuid());
end $$;

-- ---------------------------------------------------------------------------
-- Claim: recheck role, preference and access at delivery time
-- ---------------------------------------------------------------------------
create or replace function public.claim_due_notifications(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (notification_id uuid, lease_token uuid, chat_id bigint, kind text, payload jsonb, attempts integer)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_max_attempts constant integer := 5;
  r record;
  v_token uuid;
  v_skip text;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  for r in
    select n.id, n.kind, n.payload, n.attempts, n.lead_id, n.follow_up_id, n.created_at, n.recipient_id,
      p.is_active, p.role, t.chat_id as t_chat, t.status as t_status, s.disabled_kinds
    from public.telegram_notifications n
    join public.profiles p on p.id = n.recipient_id
    left join public.telegram_connections t on t.user_id = n.recipient_id
    left join public.notification_settings s on s.user_id = n.recipient_id
    where n.state in ('pending', 'processing') and n.next_attempt_at <= now()
    order by n.next_attempt_at, n.id
    limit p_limit
    for update of n skip locked
  loop
    v_skip := null;
    if not r.is_active or not (r.kind = any(private.notification_kinds_for(r.role))) then
      v_skip := 'recipient_inactive';
    elsif r.kind <> 'test' and r.kind = any(coalesce(r.disabled_kinds, '{}')) then
      v_skip := 'disabled_by_user';
    elsif r.lead_id is not null and not exists (
      select 1 from public.leads l
      where l.id = r.lead_id and l.archived_at is null and (r.role = 'admin' or l.owner_id = r.recipient_id)) then
      v_skip := 'no_lead_access';
    elsif r.kind = 'overdue_nag' and (r.created_at < now() - interval '10 minutes' or not exists (
      select 1 from public.follow_ups f
      where f.id = r.follow_up_id and f.state = 'pending' and f.due_at < now()
        and f.assignee_id = r.recipient_id and f.revision = (r.payload ->> 'revision')::integer
        and not exists (select 1 from public.follow_up_nag_silences x where x.follow_up_id = f.id and x.revision = f.revision))) then
      v_skip := 'no_longer_overdue';
    end if;
    if v_skip is not null then
      update public.telegram_notifications
        set state = case when r.kind = 'overdue_nag' then 'cancelled' else 'skipped' end::public.reminder_state,
            last_error = v_skip, lease_token = null
        where id = r.id;
      continue;
    end if;
    if r.attempts >= v_max_attempts then
      update public.telegram_notifications set state = 'failed', last_error = coalesce(last_error, 'max_attempts_reached'), lease_token = null where id = r.id;
      continue;
    end if;
    if r.t_chat is null or r.t_status <> 'connected' then
      update public.telegram_notifications set state = 'failed', lease_token = null,
        last_error = case when r.t_chat is null then 'telegram_not_connected' else 'telegram_blocked' end
      where id = r.id;
      continue;
    end if;
    v_token := gen_random_uuid();
    update public.telegram_notifications set state = 'processing', attempts = attempts + 1, lease_token = v_token,
      next_attempt_at = now() + make_interval(secs => p_lease_seconds)
    where id = r.id;
    notification_id := r.id;
    lease_token := v_token;
    chat_id := r.t_chat;
    kind := r.kind;
    payload := r.payload;
    attempts := r.attempts + 1;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.notification_kinds_for(public.app_role),
  private.enqueue_notification(uuid, text, jsonb, text, uuid, uuid, uuid),
  private.enqueue_for_roles(public.app_role[], text, jsonb, text, uuid, uuid),
  private.notify_lead_activity(),
  private.notify_finance_entry(),
  private.notify_library_file(),
  private.enqueue_overdue_nags(timestamptz),
  private.enqueue_digests(timestamptz),
  public.silence_follow_up_nag(bigint, uuid),
  public.set_notification_pref(text, boolean),
  public.send_test_notification()
from public, anon, authenticated;

grant execute on function public.set_notification_pref(text, boolean), public.send_test_notification() to authenticated;
grant execute on function public.silence_follow_up_nag(bigint, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Cron (enqueue only; the every-minute worker job delivers)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-overdue-nags', '*/5 * * * *', 'select private.enqueue_overdue_nags()');
    perform cron.schedule('crm-digests', '*/15 * * * *', 'select private.enqueue_digests()');
  end if;
end $$;
