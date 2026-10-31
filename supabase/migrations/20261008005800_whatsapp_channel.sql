-- ---------------------------------------------------------------------------
-- WhatsApp as a second alert channel next to Telegram. Each person has exactly one active channel
-- (notification_settings.channel); every Telegram alert and follow-up reminder goes to that channel.
--
-- One business number for the whole CRM (keys only in Edge Function secrets, never in the database).
-- A person links their number by sending a one-time code to it from WhatsApp; Meta's signed webhook
-- (Edge Function whatsapp-webhook) proves the number is theirs.
--
-- Free sending: WhatsApp allows free-form messages for 24 hours after the person last wrote to the
-- business. The worker reminds them about an hour before that ends (a "Keep alerts on" button; any reply
-- renews it). When the window has closed, alerts are held (pending, not sent) until they write again,
-- and dropped after 3 days. Nothing here sends paid templates unless the worker is configured to.
-- ---------------------------------------------------------------------------

-- ----- Tables ---------------------------------------------------------------
create table public.whatsapp_connections (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  -- The sender's number as Meta reports it (digits with country code, no +).
  wa_id text not null unique check (wa_id ~ '^[0-9]{6,20}$'),
  status text not null default 'connected' check (status in ('connected', 'blocked')),
  -- The person's last message to the business: the free window runs 24 hours from here.
  last_inbound_at timestamptz not null default now(),
  nudged_at timestamptz,          -- "keep alerts on" reminder sent for the current window
  paused_noticed_at timestamptz,  -- in-app "WhatsApp paused" item filed for the current closed window
  reopen_sent_at timestamptz,     -- optional paid template sent for the current closed window
  last_error text check (last_error is null or char_length(last_error) <= 300),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index whatsapp_connections_nudge_idx on public.whatsapp_connections (last_inbound_at) where status = 'connected';
create trigger whatsapp_connections_touch before update on public.whatsapp_connections
  for each row execute function private.touch_updated_at();
-- Read only through definer functions (my_notify_channels masks the number).
alter table public.whatsapp_connections enable row level security;
revoke all on public.whatsapp_connections from anon, authenticated;

create table public.whatsapp_link_codes (
  code_hash text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index whatsapp_link_codes_user_idx on public.whatsapp_link_codes (user_id, created_at);
alter table public.whatsapp_link_codes enable row level security;
revoke all on public.whatsapp_link_codes from anon, authenticated;

-- When the webhook last saw each kind of call (one row per kind, so it never grows). For Super settings.
create table public.whatsapp_webhook_seen (
  kind text primary key check (kind in ('message', 'link', 'status_failed', 'unknown_sender')),
  seen_at timestamptz not null default now()
);
alter table public.whatsapp_webhook_seen enable row level security;
revoke all on public.whatsapp_webhook_seen from anon, authenticated;

alter table public.notification_settings
  add column channel text not null default 'telegram' check (channel in ('telegram', 'whatsapp'));

-- The channel used on the last attempt, and WhatsApp's message id (matched by delivery reports).
alter table public.reminder_deliveries add column channel text, add column external_id text;
alter table public.telegram_notifications add column channel text, add column external_id text;
create index reminder_deliveries_external_idx on public.reminder_deliveries (external_id) where external_id is not null;
create index telegram_notifications_external_idx on public.telegram_notifications (external_id) where external_id is not null;
create index reminder_deliveries_held_idx on public.reminder_deliveries (recipient_id)
  where state = 'pending' and last_error = 'whatsapp_window_closed';
create index telegram_notifications_held_idx on public.telegram_notifications (recipient_id)
  where state = 'pending' and last_error = 'whatsapp_window_closed';

-- ----- Helpers --------------------------------------------------------------

-- The free window is open (5 minutes of margin before WhatsApp's 24 hours).
create function private.wa_window_open(p_last_inbound timestamptz)
returns boolean
language sql stable set search_path = ''
as $$ select p_last_inbound > now() - interval '23 hours 55 minutes' $$;

-- The person's active channel ('telegram' unless they chose WhatsApp).
create function private.notify_channel(p_user uuid)
returns text
language sql stable security definer set search_path = ''
as $$ select coalesce((select s.channel from public.notification_settings s where s.user_id = p_user), 'telegram') $$;

-- Their active channel is linked and can receive (a closed WhatsApp window still counts: alerts are held).
create function private.channel_ready(p_user uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case private.notify_channel(p_user)
    when 'whatsapp' then exists (select 1 from public.whatsapp_connections w where w.user_id = p_user and w.status = 'connected')
    else exists (select 1 from public.telegram_connections t where t.user_id = p_user and t.status = 'connected')
  end
$$;

create function private.set_notify_channel(p_user uuid, p_channel text)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.notification_settings as s (user_id, channel) values (p_user, p_channel)
  on conflict (user_id) do update set channel = excluded.channel, updated_at = now()
$$;

-- Held alerts are sent now (the person wrote, so the window is open again). Returns how many.
create function private.release_held(p_user uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_a integer;
  v_b integer;
begin
  update public.reminder_deliveries set next_attempt_at = now()
    where recipient_id = p_user and state = 'pending' and last_error = 'whatsapp_window_closed';
  get diagnostics v_a = row_count;
  update public.telegram_notifications set next_attempt_at = now()
    where recipient_id = p_user and state = 'pending' and last_error = 'whatsapp_window_closed';
  get diagnostics v_b = row_count;
  return v_a + v_b;
end $$;

-- Once per closed window: an in-app item saying WhatsApp alerts are waiting.
create function private.note_whatsapp_paused(p_user uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_last timestamptz;
begin
  update public.whatsapp_connections w set paused_noticed_at = now()
    where w.user_id = p_user and (w.paused_noticed_at is null or w.paused_noticed_at < w.last_inbound_at)
    returning w.last_inbound_at into v_last;
  if found then
    insert into public.app_notifications (recipient_id, kind, payload, dedupe_key)
    values (p_user, 'whatsapp_paused', '{}'::jsonb, 'wa-paused:' || floor(extract(epoch from v_last))::bigint)
    on conflict do nothing;
  end if;
end $$;

-- Keeps a queued alert waiting for the window: not counted as an attempt, retried in 3 days at the latest
-- (when it is dropped unless the person wrote meanwhile, which releases it at once).
create function private.hold_reason(p_last_error text)
returns text
language sql immutable set search_path = ''
as $$ select case when p_last_error = 'whatsapp_window_closed' then 'whatsapp_window_expired' else null end $$;

-- ----- Enqueue: follow the active channel ------------------------------------
create or replace function private.enqueue_notification(
  p_recipient uuid, p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null, p_follow_up_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_phone boolean;
begin
  if p_recipient is null or p_recipient = p_actor then
    return false;
  end if;
  -- The phone message (Telegram or WhatsApp, whichever is active); the channel is picked when it is sent.
  insert into public.telegram_notifications (recipient_id, kind, payload, dedupe_key, lead_id, follow_up_id)
  select p.id, p_kind, p_payload, p_dedupe, p_lead_id, p_follow_up_id
  from public.profiles p
  left join public.notification_settings s on s.user_id = p.id
  where p.id = p_recipient and p.is_active
    and private.channel_ready(p.id)
    and p_kind = any(private.notification_kinds_for_roles(p.role, p.extra_roles))
    and not (p_kind = any(coalesce(s.disabled_kinds, '{}')))
  on conflict do nothing;
  v_phone := found;

  if p_kind <> 'test' then
    insert into public.app_notifications (recipient_id, kind, payload, dedupe_key)
    select p.id, p_kind, p_payload,
      case when p_kind = 'overdue_nag' and p_follow_up_id is not null
        then 'overdue:' || p_follow_up_id || ':' || coalesce(p_payload ->> 'revision', '0') else p_dedupe end
    from public.profiles p
    left join public.notification_settings s on s.user_id = p.id
    where p.id = p_recipient and p.is_active
      and p_kind = any(private.notification_kinds_for_roles(p.role, p.extra_roles))
      and not (p_kind = any(coalesce(s.muted_app_kinds, '{}')))
    on conflict do nothing;
  end if;
  return v_phone;
end $$;

-- ----- Claim (worker, service role). Same checks as before (latest: 20261005000300 for reminders,
-- 20261008000800 for notifications), plus the channel. -------------------------------------------
drop function public.claim_due_reminders(integer, integer);
create function public.claim_due_reminders(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (
  delivery_id uuid,
  lease_token uuid,
  chat_id bigint,
  lead_id uuid,
  lead_name text,
  lead_phone text,
  task text,
  due_at timestamptz,
  attempts integer,
  channel text,
  wa_id text
)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_max_attempts constant integer := 5;
  r record;
  v_reason text;
  v_token uuid;
  v_channel text;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);

  for r in
    select d.id, d.revision, d.attempts, d.recipient_id, d.last_error as d_error,
           f.id as follow_up_id, f.state as fu_state, f.revision as fu_revision, f.assignee_id, f.task as fu_task, f.due_at as fu_due,
           l.id as l_id, l.name as l_name, l.phone as l_phone, l.owner_id, l.archived_at,
           p.is_active, t.chat_id as t_chat, t.status as t_status,
           coalesce(s.channel, 'telegram') as ch, w.wa_id as w_id, w.status as w_status, w.last_inbound_at as w_last
    from public.reminder_deliveries d
    join public.follow_ups f on f.id = d.follow_up_id
    join public.leads l on l.id = f.lead_id
    join public.profiles p on p.id = d.recipient_id
    left join public.telegram_connections t on t.user_id = d.recipient_id
    left join public.notification_settings s on s.user_id = d.recipient_id
    left join public.whatsapp_connections w on w.user_id = d.recipient_id
    where d.state in ('pending', 'processing') and d.next_attempt_at <= now()
    order by d.next_attempt_at, d.id
    limit p_limit
    for update of d skip locked
  loop
    v_reason := case
      when r.fu_state <> 'pending' then 'follow_up_' || r.fu_state::text
      when r.fu_revision <> r.revision then 'superseded'
      when r.archived_at is not null then 'lead_archived'
      when r.assignee_id <> r.recipient_id or r.owner_id <> r.recipient_id then 'recipient_changed'
      when not r.is_active then 'recipient_inactive'
      else null end;

    if v_reason is not null then
      update public.reminder_deliveries
        set state = case when v_reason in ('superseded', 'follow_up_completed', 'follow_up_cancelled')
                         then 'cancelled' else 'skipped' end::public.reminder_state,
            last_error = v_reason, lease_token = null
        where id = r.id;
      continue;
    end if;

    if r.attempts >= v_max_attempts then
      update public.reminder_deliveries
        set state = 'failed', last_error = coalesce(last_error, 'max_attempts_reached'), lease_token = null
        where id = r.id;
      continue;
    end if;

    v_channel := r.ch;
    if v_channel = 'whatsapp' then
      if r.w_id is null or r.w_status <> 'connected' then
        update public.reminder_deliveries set state = 'failed', lease_token = null, channel = 'whatsapp',
          last_error = case when r.w_id is null then 'whatsapp_not_connected' else 'whatsapp_blocked' end
        where id = r.id;
        continue;
      end if;
      if not private.wa_window_open(r.w_last) then
        if private.hold_reason(r.d_error) is not null then
          update public.reminder_deliveries set state = 'skipped', lease_token = null, last_error = 'whatsapp_window_expired' where id = r.id;
        else
          update public.reminder_deliveries set state = 'pending', lease_token = null, channel = 'whatsapp',
            last_error = 'whatsapp_window_closed', next_attempt_at = now() + interval '3 days'
          where id = r.id;
          perform private.note_whatsapp_paused(r.recipient_id);
        end if;
        continue;
      end if;
    elsif r.t_chat is null or r.t_status <> 'connected' then
      update public.reminder_deliveries
        set state = 'failed', lease_token = null, channel = 'telegram',
            last_error = case when r.t_chat is null then 'telegram_not_connected' else 'telegram_blocked' end
        where id = r.id;
      continue;
    end if;

    v_token := gen_random_uuid();
    update public.reminder_deliveries
      set state = 'processing', attempts = attempts + 1, lease_token = v_token, channel = v_channel,
          next_attempt_at = now() + make_interval(secs => p_lease_seconds)
      where id = r.id;

    delivery_id := r.id;
    lease_token := v_token;
    chat_id := case when v_channel = 'telegram' then r.t_chat end;
    lead_id := r.l_id;
    lead_name := r.l_name;
    lead_phone := r.l_phone;
    task := r.fu_task;
    due_at := r.fu_due;
    attempts := r.attempts + 1;
    channel := v_channel;
    wa_id := case when v_channel = 'whatsapp' then r.w_id end;
    return next;
  end loop;
end $$;

drop function public.claim_due_notifications(integer, integer);
create function public.claim_due_notifications(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (notification_id uuid, lease_token uuid, chat_id bigint, kind text, payload jsonb, attempts integer, channel text, wa_id text)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_max_attempts constant integer := 5;
  r record;
  v_token uuid;
  v_skip text;
  v_channel text;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  for r in
    select n.id, n.kind, n.payload, n.attempts, n.lead_id, n.follow_up_id, n.created_at, n.recipient_id, n.last_error as n_error,
      nullif(n.payload ->> 'project_id', '')::uuid as project_id,
      p.is_active, p.role, p.extra_roles, p.company_id, t.chat_id as t_chat, t.status as t_status, s.disabled_kinds,
      coalesce(s.channel, 'telegram') as ch, w.wa_id as w_id, w.status as w_status, w.last_inbound_at as w_last
    from public.telegram_notifications n
    join public.profiles p on p.id = n.recipient_id
    left join public.telegram_connections t on t.user_id = n.recipient_id
    left join public.notification_settings s on s.user_id = n.recipient_id
    left join public.whatsapp_connections w on w.user_id = n.recipient_id
    where n.state in ('pending', 'processing') and n.next_attempt_at <= now()
    order by n.next_attempt_at, n.id
    limit p_limit
    for update of n skip locked
  loop
    v_skip := null;
    if not r.is_active or not (r.kind = any(private.notification_kinds_for_roles(r.role, r.extra_roles))) then
      v_skip := 'recipient_inactive';
    elsif r.kind <> 'test' and r.kind = any(coalesce(r.disabled_kinds, '{}')) then
      v_skip := 'disabled_by_user';
    elsif r.lead_id is not null and not exists (
      select 1 from public.leads l
      where l.id = r.lead_id and l.archived_at is null
        and (r.role = 'super_admin' or ((r.role = 'admin' or 'admin' = any(r.extra_roles)) and l.company_id = r.company_id) or l.owner_id = r.recipient_id)) then
      v_skip := 'no_lead_access';
    elsif r.project_id is not null and not (
      -- Project alerts: the recipient must still be on the project (admins: in its company; money alerts: admin/account).
      exists (select 1 from public.projects pr where pr.id = r.project_id and pr.archived_at is null and (
        r.role = 'super_admin'
        or ((r.role = 'admin' or 'admin' = any(r.extra_roles)) and pr.company_id = r.company_id)
        or (r.kind in ('payment_due', 'payment_overdue', 'payment_received')
            and (r.role = 'account' or 'account' = any(r.extra_roles)) and pr.company_id = r.company_id)
        or (r.kind not in ('payment_due', 'payment_overdue', 'payment_received') and exists (
            select 1 from public.project_members m where m.project_id = pr.id and m.user_id = r.recipient_id
              and m.removed_at is null and m.member_role <> 'client'))))) then
      v_skip := 'no_project_access';
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

    v_channel := r.ch;
    if v_channel = 'whatsapp' then
      if r.w_id is null or r.w_status <> 'connected' then
        update public.telegram_notifications set state = 'failed', lease_token = null, channel = 'whatsapp',
          last_error = case when r.w_id is null then 'whatsapp_not_connected' else 'whatsapp_blocked' end
        where id = r.id;
        continue;
      end if;
      if not private.wa_window_open(r.w_last) then
        if private.hold_reason(r.n_error) is not null then
          update public.telegram_notifications set state = 'skipped', lease_token = null, last_error = 'whatsapp_window_expired' where id = r.id;
        else
          update public.telegram_notifications set state = 'pending', lease_token = null, channel = 'whatsapp',
            last_error = 'whatsapp_window_closed', next_attempt_at = now() + interval '3 days'
          where id = r.id;
          perform private.note_whatsapp_paused(r.recipient_id);
        end if;
        continue;
      end if;
    elsif r.t_chat is null or r.t_status <> 'connected' then
      update public.telegram_notifications set state = 'failed', lease_token = null, channel = 'telegram',
        last_error = case when r.t_chat is null then 'telegram_not_connected' else 'telegram_blocked' end
      where id = r.id;
      continue;
    end if;

    v_token := gen_random_uuid();
    update public.telegram_notifications set state = 'processing', attempts = attempts + 1, lease_token = v_token, channel = v_channel,
      next_attempt_at = now() + make_interval(secs => p_lease_seconds)
    where id = r.id;
    notification_id := r.id;
    lease_token := v_token;
    chat_id := case when v_channel = 'telegram' then r.t_chat end;
    kind := r.kind;
    payload := r.payload;
    attempts := r.attempts + 1;
    channel := v_channel;
    wa_id := case when v_channel = 'whatsapp' then r.w_id end;
    return next;
  end loop;
end $$;

-- ----- Finish (worker): also 'hold' (WhatsApp said the window had closed) and WhatsApp's message id ----------
drop function public.finish_reminder(uuid, uuid, text, text, integer, bigint);
create function public.finish_reminder(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_result text,
  p_error text default null,
  p_retry_after_seconds integer default null,
  p_message_id bigint default null,
  p_external_id text default null
)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_max_attempts constant integer := 5;
  v_row public.reminder_deliveries%rowtype;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
begin
  if p_result not in ('sent', 'retry', 'failed', 'blocked', 'hold') then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  select * into v_row from public.reminder_deliveries d
    where d.id = p_delivery_id and d.lease_token = p_lease_token and d.state = 'processing'
    for update;
  if not found then
    return 'lease_lost';
  end if;

  if p_result = 'sent' then
    update public.reminder_deliveries set state = 'sent', sent_at = now(), last_error = null,
      lease_token = null, telegram_message_id = p_message_id, external_id = left(p_external_id, 200)
      where id = v_row.id;
    return 'sent';
  end if;

  if p_result = 'hold' then
    update public.reminder_deliveries set state = 'pending', lease_token = null, attempts = greatest(attempts - 1, 0),
      last_error = 'whatsapp_window_closed', next_attempt_at = now() + interval '3 days'
      where id = v_row.id;
    update public.whatsapp_connections set last_inbound_at = least(last_inbound_at, now() - interval '24 hours')
      where user_id = v_row.recipient_id;
    perform private.note_whatsapp_paused(v_row.recipient_id);
    return 'pending';
  end if;

  if p_result = 'retry' and v_row.attempts < v_max_attempts then
    update public.reminder_deliveries set state = 'pending', lease_token = null, last_error = v_error,
      next_attempt_at = now() + make_interval(secs => least(greatest(
        coalesce(p_retry_after_seconds, 60 * power(2, v_row.attempts - 1)::integer), 30), 3600))
      where id = v_row.id;
    return 'pending';
  end if;

  update public.reminder_deliveries set state = 'failed', lease_token = null,
    last_error = coalesce(v_error, 'delivery_failed')
    where id = v_row.id;
  if p_result = 'blocked' then
    if v_row.channel = 'whatsapp' then
      update public.whatsapp_connections set status = 'blocked', last_error = v_error where user_id = v_row.recipient_id;
    else
      update public.telegram_connections set status = 'blocked', last_error = v_error where user_id = v_row.recipient_id;
    end if;
  end if;
  return 'failed';
end $$;

drop function public.finish_notification(uuid, uuid, text, text, integer);
create function public.finish_notification(
  p_id uuid, p_lease_token uuid, p_result text, p_error text default null, p_retry_after_seconds integer default null,
  p_external_id text default null
)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.telegram_notifications%rowtype;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
begin
  if p_result not in ('sent', 'retry', 'failed', 'blocked', 'hold') then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  select * into v_row from public.telegram_notifications n
    where n.id = p_id and n.lease_token = p_lease_token and n.state = 'processing' for update;
  if not found then
    return 'lease_lost';
  end if;
  if p_result = 'sent' then
    update public.telegram_notifications set state = 'sent', sent_at = now(), last_error = null, lease_token = null,
      external_id = left(p_external_id, 200)
    where id = v_row.id;
    return 'sent';
  end if;
  if p_result = 'hold' then
    update public.telegram_notifications set state = 'pending', lease_token = null, attempts = greatest(attempts - 1, 0),
      last_error = 'whatsapp_window_closed', next_attempt_at = now() + interval '3 days'
    where id = v_row.id;
    update public.whatsapp_connections set last_inbound_at = least(last_inbound_at, now() - interval '24 hours')
      where user_id = v_row.recipient_id;
    perform private.note_whatsapp_paused(v_row.recipient_id);
    return 'pending';
  end if;
  if p_result = 'retry' and v_row.attempts < 5 then
    update public.telegram_notifications set state = 'pending', lease_token = null, last_error = v_error,
      next_attempt_at = now() + make_interval(secs => least(greatest(
        coalesce(p_retry_after_seconds, 60 * power(2, v_row.attempts - 1)::integer), 30), 3600))
    where id = v_row.id;
    return 'pending';
  end if;
  update public.telegram_notifications set state = 'failed', lease_token = null, last_error = coalesce(v_error, 'delivery_failed') where id = v_row.id;
  if p_result = 'blocked' then
    if v_row.channel = 'whatsapp' then
      update public.whatsapp_connections set status = 'blocked', last_error = v_error where user_id = v_row.recipient_id;
    else
      update public.telegram_connections set status = 'blocked', last_error = v_error where user_id = v_row.recipient_id;
    end if;
  end if;
  return 'failed';
end $$;

-- ----- Bot summary: one body for both bots ------------------------------------
create function private.bot_summary(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_day date := (v_now at time zone 'Asia/Kolkata')::date;
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_day_end timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_month_start date := date_trunc('month', v_day)::date;
  v_next_month date := (date_trunc('month', v_day) + interval '1 month')::date;
  v_user record;
  v_company uuid;
  v_roles text[];
  v_out jsonb;
begin
  select p.id, p.display_name, p.role::text as role, coalesce(p.active_company_id, p.company_id) as company_id,
    array[p.role::text] || p.extra_roles::text[] as roles
    into v_user
  from public.profiles p
  where p.id = p_user and p.is_active;
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  v_company := v_user.company_id;
  v_roles := v_user.roles;
  v_out := jsonb_build_object('connected', true, 'name', v_user.display_name, 'role', v_user.role, 'roles', to_jsonb(v_roles), 'date', v_day);

  -- My follow-ups (people who own leads).
  if v_roles && array['sales', 'admin', 'super_admin'] then
    v_out := v_out || (
      select jsonb_build_object(
        'today', count(*) filter (where f.due_at >= v_day_start and f.due_at < v_day_end),
        'overdue', count(*) filter (where f.due_at < v_now))
      from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.assignee_id = v_user.id and f.state = 'pending'
    ) || jsonb_build_object('tasks', (
      select coalesce(jsonb_agg(t order by t.due_at, t.id), '[]'::jsonb) from (
        select f.id, f.task, f.due_at, l.name as lead_name, f.due_at < v_now as overdue
        from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where f.assignee_id = v_user.id and f.state = 'pending' and f.due_at < v_day_end
        order by f.due_at, f.id limit 5
      ) t));
  end if;

  -- Admin: the company's day at a glance.
  if v_roles && array['admin', 'super_admin'] and v_company is not null then
    v_out := v_out || jsonb_build_object('team', jsonb_build_object(
      'new_leads', (select count(*) from public.leads l
        where l.company_id = v_company and l.created_at >= v_day_start and l.created_at < v_day_end),
      'won', (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id
        where l.company_id = v_company and a.type = 'status_changed'
          and coalesce(a.meta ->> 'to_kind', a.meta ->> 'to') = 'won'
          and a.created_at >= v_day_start and a.created_at < v_day_end),
      'overdue', (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where l.company_id = v_company and f.state = 'pending' and f.due_at < v_now)));
  end if;

  -- Account: this month in the user's books (every company sharing them).
  if 'account' = any(v_roles) and v_company is not null then
    v_out := v_out || (
      with books as (
        select x.id from public.companies x
        where x.archived_at is null
          and x.finance_group_id = (select c.finance_group_id from public.companies c where c.id = v_company)
      )
      select jsonb_build_object('finance', jsonb_build_object(
        'month', to_char(v_month_start, 'YYYY-MM'),
        'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.company_id in (select id from books)
          and e.archived_at is null and e.expense_date >= v_month_start and e.expense_date < v_next_month), 0),
        'expense_count', (select count(*) from public.expenses e where e.company_id in (select id from books)
          and e.archived_at is null and e.expense_date >= v_month_start and e.expense_date < v_next_month),
        'capital_total', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id in (select id from books)
          and k.archived_at is null and k.entry_date >= v_month_start and k.entry_date < v_next_month), 0)))
    );
  end if;

  -- Ads manager: ad accounts that stopped syncing, in the companies they manage.
  if v_user.role = 'ads_manager' then
    v_out := v_out || (
      select jsonb_build_object('ads', jsonb_build_object(
        'problem_count', count(*),
        'problem_names', coalesce((array_agg(coalesce(a.name, 'act_' || a.act_id) order by a.name nulls last))[1:3], '{}')))
      from public.ad_accounts a
      join public.ads_manager_companies m on m.company_id = a.company_id and m.user_id = v_user.id
      where a.status = 'error'
    );
  end if;

  return v_out;
end $$;

create or replace function public.telegram_bot_summary(p_chat_id bigint)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select private.bot_summary(t.user_id) from public.telegram_connections t
    where t.chat_id = p_chat_id and t.status = 'connected'
  ), jsonb_build_object('connected', false))
$$;

create function public.whatsapp_bot_summary(p_wa_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select private.bot_summary(w.user_id) from public.whatsapp_connections w
    where w.wa_id = p_wa_id and w.status = 'connected'
  ), jsonb_build_object('connected', false))
$$;

-- ----- Linking ----------------------------------------------------------------

-- A 6-character code (letters and digits, never 0/O/1/I) for the signed-in person, valid 10 minutes, once.
-- Only its hash is stored. At most 5 per hour; a new code replaces the previous open one.
create function public.create_whatsapp_link()
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  v_bytes bytea;
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  if (select count(*) from public.whatsapp_link_codes c where c.user_id = v_uid and c.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'rate_limited' using errcode = '22023';
  end if;
  delete from public.whatsapp_link_codes c where c.expires_at < now() - interval '1 day';
  update public.whatsapp_link_codes c set expires_at = least(c.expires_at, now())
    where c.user_id = v_uid and c.consumed_at is null and c.expires_at > now();
  for i in 1..20 loop
    v_bytes := uuid_send(gen_random_uuid());
    v_code := '';
    for j in 0..5 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, j) % 32) + 1, 1);
    end loop;
    -- A digit and a letter, so ordinary words in a message are never taken for a code.
    continue when v_code !~ '[0-9]' or v_code !~ '[A-Z]';
    begin
      insert into public.whatsapp_link_codes (code_hash, user_id, expires_at)
      values (encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), v_uid, now() + interval '10 minutes');
      return v_code;
    exception when unique_violation then
      null; -- the same code is open for someone else: draw again
    end;
  end loop;
  raise exception 'try_again' using errcode = '22023';
end $$;

-- Every message the business number receives (verified webhook, service role). With a valid code it links
-- the sender's number to that code's person (moving it from anyone else who had it: the sender holds the
-- phone) and makes WhatsApp their channel. From a linked number it renews the free window and sends what
-- was held.
create function public.whatsapp_inbound(p_wa_id text, p_code text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_name text;
  v_released integer;
  v_old uuid;
begin
  if p_wa_id is null or p_wa_id !~ '^[0-9]{6,20}$' then
    return jsonb_build_object('connected', false);
  end if;

  if p_code is not null and upper(p_code) ~ '^[A-Z2-9]{6}$' then
    update public.whatsapp_link_codes c set consumed_at = now()
      where c.code_hash = encode(sha256(convert_to(upper(p_code), 'UTF8')), 'hex')
        and c.consumed_at is null and c.expires_at > now()
      returning c.user_id into v_user;
    if v_user is not null then
      select p.display_name into v_name from public.profiles p where p.id = v_user and p.is_active;
    end if;
    if v_name is not null then
      insert into public.whatsapp_webhook_seen (kind) values ('link')
        on conflict (kind) do update set seen_at = now();
      -- A number belongs to one CRM person at a time.
      select w.user_id into v_old from public.whatsapp_connections w where w.wa_id = p_wa_id and w.user_id <> v_user;
      if v_old is not null then
        delete from public.whatsapp_connections w where w.user_id = v_old;
        if private.notify_channel(v_old) = 'whatsapp' then
          perform private.set_notify_channel(v_old, 'telegram');
          perform private.release_held(v_old);
        end if;
      end if;
      insert into public.whatsapp_connections as w (user_id, wa_id, status, last_inbound_at, connected_at)
      values (v_user, p_wa_id, 'connected', now(), now())
      on conflict (user_id) do update set wa_id = excluded.wa_id, status = 'connected', last_error = null,
        last_inbound_at = now(), nudged_at = null, paused_noticed_at = null, reopen_sent_at = null, connected_at = now();
      perform private.set_notify_channel(v_user, 'whatsapp');
      perform private.release_held(v_user);
      return jsonb_build_object('connected', true, 'linked', true, 'name', v_name);
    end if;
  end if;

  select w.user_id, p.display_name into v_user, v_name
  from public.whatsapp_connections w join public.profiles p on p.id = w.user_id and p.is_active
  where w.wa_id = p_wa_id;
  if v_user is null then
    insert into public.whatsapp_webhook_seen (kind) values ('unknown_sender')
      on conflict (kind) do update set seen_at = now();
    return jsonb_build_object('connected', false, 'code_invalid', p_code is not null);
  end if;
  insert into public.whatsapp_webhook_seen (kind) values ('message')
    on conflict (kind) do update set seen_at = now();
  -- Writing to the business means they can receive again (an unblock shows up this way too).
  update public.whatsapp_connections set last_inbound_at = now(), status = 'connected', last_error = null, nudged_at = null
    where user_id = v_user;
  v_released := private.release_held(v_user);
  return jsonb_build_object('connected', true, 'linked', false, 'name', v_name, 'released', v_released,
    'code_invalid', p_code is not null, 'active', private.notify_channel(v_user) = 'whatsapp');
end $$;

-- 🔕 Silence on an overdue alert, tapped in WhatsApp. Only the follow-up's assignee can silence it.
create function public.whatsapp_silence_nag(p_wa_id text, p_follow_up_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_fu record;
begin
  select w.user_id into v_user
  from public.whatsapp_connections w join public.profiles p on p.id = w.user_id and p.is_active
  where w.wa_id = p_wa_id and w.status = 'connected';
  if v_user is null then
    return jsonb_build_object('ok', false);
  end if;
  select f.id, f.revision, f.assignee_id, l.name as lead_name into v_fu
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

-- Delivery reports from WhatsApp (verified webhook). Only failures matter: 131047 means the window had
-- closed (the alert waits again), 131026 means the number can't receive (shown as blocked in the CRM).
create function public.whatsapp_delivery_status(p_external_id text, p_status text, p_error_code integer default null)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_user uuid;
  v_table text;
  v_error text;
begin
  if p_status is distinct from 'failed' or p_external_id is null then
    return 'ignored';
  end if;
  select d.id, d.recipient_id into v_id, v_user from public.reminder_deliveries d
    where d.external_id = p_external_id and d.state = 'sent' for update;
  if found then
    v_table := 'reminder';
  else
    select n.id, n.recipient_id into v_id, v_user from public.telegram_notifications n
      where n.external_id = p_external_id and n.state = 'sent' for update;
    if not found then
      return 'not_found';
    end if;
    v_table := 'notification';
  end if;
  insert into public.whatsapp_webhook_seen (kind) values ('status_failed')
    on conflict (kind) do update set seen_at = now();

  if p_error_code = 131047 then
    if v_table = 'reminder' then
      update public.reminder_deliveries set state = 'pending', sent_at = null, last_error = 'whatsapp_window_closed',
        next_attempt_at = now() + interval '3 days' where id = v_id;
    else
      update public.telegram_notifications set state = 'pending', sent_at = null, last_error = 'whatsapp_window_closed',
        next_attempt_at = now() + interval '3 days' where id = v_id;
    end if;
    update public.whatsapp_connections set last_inbound_at = least(last_inbound_at, now() - interval '24 hours') where user_id = v_user;
    perform private.note_whatsapp_paused(v_user);
    return 'held';
  end if;

  v_error := case when p_error_code = 131026 then 'whatsapp_undeliverable'
                  else 'whatsapp_error_' || coalesce(p_error_code::text, 'unknown') end;
  if v_table = 'reminder' then
    update public.reminder_deliveries set state = 'failed', last_error = v_error where id = v_id;
  else
    update public.telegram_notifications set state = 'failed', last_error = v_error where id = v_id;
  end if;
  if p_error_code = 131026 then
    update public.whatsapp_connections set status = 'blocked', last_error = v_error where user_id = v_user;
    return 'blocked';
  end if;
  return 'failed';
end $$;

-- People to remind before their free window closes ('nudge', free), and, only when the worker has a paid
-- template configured (p_reopen), people whose window closed with alerts waiting ('reopen', once per
-- closed window). Marks them so each window gets one of each at most.
create function public.claim_whatsapp_prompts(p_limit integer default 25, p_reopen boolean default false)
returns table (user_id uuid, wa_id text, kind text, name text, held integer)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  for r in
    select w.user_id as u, w.wa_id as wid, p.display_name as dn
    from public.whatsapp_connections w
    join public.profiles p on p.id = w.user_id and p.is_active
    join public.notification_settings s on s.user_id = w.user_id and s.channel = 'whatsapp'
    where w.status = 'connected'
      and w.last_inbound_at between now() - interval '23 hours 50 minutes' and now() - interval '22 hours 45 minutes'
      and (w.nudged_at is null or w.nudged_at < w.last_inbound_at)
    order by w.last_inbound_at
    limit p_limit
    for update of w skip locked
  loop
    update public.whatsapp_connections set nudged_at = now() where whatsapp_connections.user_id = r.u;
    user_id := r.u; wa_id := r.wid; kind := 'nudge'; name := r.dn; held := 0;
    return next;
  end loop;

  if p_reopen then
    for r in
      select w.user_id as u, w.wa_id as wid, p.display_name as dn,
        (select count(*) from public.reminder_deliveries d where d.recipient_id = w.user_id and d.state = 'pending' and d.last_error = 'whatsapp_window_closed')
        + (select count(*) from public.telegram_notifications n where n.recipient_id = w.user_id and n.state = 'pending' and n.last_error = 'whatsapp_window_closed') as h
      from public.whatsapp_connections w
      join public.profiles p on p.id = w.user_id and p.is_active
      join public.notification_settings s on s.user_id = w.user_id and s.channel = 'whatsapp'
      where w.status = 'connected' and not private.wa_window_open(w.last_inbound_at)
        and (w.reopen_sent_at is null or w.reopen_sent_at < w.last_inbound_at)
      order by w.last_inbound_at
      limit p_limit
      for update of w skip locked
    loop
      continue when r.h = 0;
      update public.whatsapp_connections set reopen_sent_at = now() where whatsapp_connections.user_id = r.u;
      user_id := r.u; wa_id := r.wid; kind := 'reopen'; name := r.dn; held := r.h;
      return next;
    end loop;
  end if;
end $$;

-- ----- The signed-in person's channels ------------------------------------------

-- Active channel and WhatsApp state (number masked: +91 ••••• 43210).
create function public.my_notify_channels()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_wa jsonb;
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  select jsonb_build_object(
    'status', w.status,
    'masked', '+' || case when length(w.wa_id) > 10 then left(w.wa_id, length(w.wa_id) - 10) || ' ' else '' end
              || '••••• ' || right(w.wa_id, 5),
    'connected_at', w.connected_at,
    'window_until', case when private.wa_window_open(w.last_inbound_at) then w.last_inbound_at + interval '24 hours' end,
    'held', (select count(*) from public.reminder_deliveries d where d.recipient_id = v_uid and d.state = 'pending' and d.last_error = 'whatsapp_window_closed')
          + (select count(*) from public.telegram_notifications n where n.recipient_id = v_uid and n.state = 'pending' and n.last_error = 'whatsapp_window_closed'),
    'last_error', w.last_error)
  into v_wa
  from public.whatsapp_connections w where w.user_id = v_uid;
  return jsonb_build_object('active', private.notify_channel(v_uid), 'whatsapp', v_wa);
end $$;

-- Pick the active channel; it must be linked.
create function public.set_notify_channel(p_channel text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  if p_channel is null or p_channel not in ('telegram', 'whatsapp') then
    raise exception 'invalid_channel' using errcode = '22023';
  end if;
  if not (case p_channel
    when 'whatsapp' then exists (select 1 from public.whatsapp_connections w where w.user_id = v_uid and w.status = 'connected')
    else exists (select 1 from public.telegram_connections t where t.user_id = v_uid and t.status = 'connected') end) then
    raise exception 'channel_not_connected' using errcode = '22023';
  end if;
  perform private.set_notify_channel(v_uid, p_channel);
  -- Alerts waiting for the WhatsApp window go out now on Telegram.
  if p_channel = 'telegram' then
    perform private.release_held(v_uid);
  end if;
  return p_channel;
end $$;

create function public.disconnect_whatsapp()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  delete from public.whatsapp_connections where user_id = v_uid;
  if private.notify_channel(v_uid) = 'whatsapp' then
    perform private.set_notify_channel(v_uid, 'telegram');
    perform private.release_held(v_uid);
  end if;
end $$;

-- Telegram: disconnecting the active channel falls back to WhatsApp when it is linked; linking makes it active.
create or replace function public.disconnect_telegram()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  delete from public.telegram_connections where user_id = v_uid;
  if private.notify_channel(v_uid) = 'telegram'
     and exists (select 1 from public.whatsapp_connections w where w.user_id = v_uid and w.status = 'connected') then
    perform private.set_notify_channel(v_uid, 'whatsapp');
  end if;
end $$;

create or replace function public.consume_telegram_link_token(p_token text, p_chat_id bigint, p_telegram_username text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_name text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' or p_chat_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update public.telegram_link_tokens t
    set consumed_at = now()
    where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
      and t.consumed_at is null and t.expires_at > now()
    returning t.user_id into v_user;
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_or_expired');
  end if;
  select p.display_name into v_name from public.profiles p where p.id = v_user and p.is_active;
  if v_name is null then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  -- A Telegram chat can belong to one CRM user at a time.
  delete from public.telegram_connections c where c.chat_id = p_chat_id and c.user_id <> v_user;
  insert into public.telegram_connections (user_id, chat_id, telegram_username, status, last_error, connected_at)
  values (v_user, p_chat_id, left(p_telegram_username, 64), 'connected', null, now())
  on conflict (user_id) do update set
    chat_id = excluded.chat_id, telegram_username = excluded.telegram_username,
    status = 'connected', last_error = null, connected_at = now();
  perform private.set_notify_channel(v_user, 'telegram');
  perform private.release_held(v_user);
  return jsonb_build_object('ok', true, 'display_name', v_name);
end $$;

-- The test message goes to whichever channel is active.
create or replace function public.send_test_notification()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  if not private.channel_ready(v_uid) then
    raise exception 'channel_not_connected' using errcode = '22023';
  end if;
  if exists (select 1 from public.telegram_notifications n where n.recipient_id = v_uid and n.kind = 'test'
             and n.created_at > now() - interval '30 seconds') then
    raise exception 'test_too_soon' using errcode = '22023';
  end if;
  perform private.enqueue_notification(v_uid, 'test',
    jsonb_build_object('name', private.display_name(v_uid), 'channel', private.notify_channel(v_uid)), 'test:' || gen_random_uuid());
end $$;

-- ----- Super settings: WhatsApp at a glance (counts only, no numbers) -------------
create function public.super_whatsapp_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return jsonb_build_object(
    'linked', (select count(*) from public.whatsapp_connections),
    'active', (select count(*) from public.whatsapp_connections w join public.notification_settings s on s.user_id = w.user_id and s.channel = 'whatsapp'
               where w.status = 'connected'),
    'open_windows', (select count(*) from public.whatsapp_connections w where w.status = 'connected' and private.wa_window_open(w.last_inbound_at)),
    'blocked', (select count(*) from public.whatsapp_connections w where w.status = 'blocked'),
    'held', (select count(*) from public.reminder_deliveries d where d.state = 'pending' and d.last_error = 'whatsapp_window_closed')
          + (select count(*) from public.telegram_notifications n where n.state = 'pending' and n.last_error = 'whatsapp_window_closed'),
    'sent_24h', (select count(*) from public.reminder_deliveries d where d.channel = 'whatsapp' and d.state = 'sent' and d.sent_at > now() - interval '24 hours')
              + (select count(*) from public.telegram_notifications n where n.channel = 'whatsapp' and n.state = 'sent' and n.sent_at > now() - interval '24 hours'),
    'failed_24h', (select count(*) from public.reminder_deliveries d where d.channel = 'whatsapp' and d.state = 'failed' and d.updated_at > now() - interval '24 hours')
                + (select count(*) from public.telegram_notifications n where n.channel = 'whatsapp' and n.state = 'failed' and n.updated_at > now() - interval '24 hours'),
    'last_failure', (select n.last_error from (
        select d.last_error, d.updated_at from public.reminder_deliveries d where d.channel = 'whatsapp' and d.state = 'failed'
        union all
        select n.last_error, n.updated_at from public.telegram_notifications n where n.channel = 'whatsapp' and n.state = 'failed'
      ) n order by n.updated_at desc limit 1),
    'seen', coalesce((select jsonb_object_agg(k.kind, k.seen_at) from public.whatsapp_webhook_seen k), '{}'::jsonb));
end $$;

-- ----- The worker is still called only when there is work: now also when a nudge is due ----------------
create or replace function private.invoke_reminder_worker()
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  if not exists (
    select 1 from public.reminder_deliveries d
    where d.state in ('pending', 'processing') and d.next_attempt_at <= now()
  ) and not exists (
    select 1 from public.telegram_notifications n
    where n.state in ('pending', 'processing') and n.next_attempt_at <= now()
  ) and not exists (
    select 1 from public.whatsapp_connections w
    join public.notification_settings s on s.user_id = w.user_id and s.channel = 'whatsapp'
    where w.status = 'connected'
      and w.last_inbound_at between now() - interval '23 hours 50 minutes' and now() - interval '22 hours 45 minutes'
      and (w.nudged_at is null or w.nudged_at < w.last_inbound_at)
  ) then
    return null;
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'crm_project_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'crm_reminder_worker_secret';
  if v_url is null or v_secret is null then
    raise warning 'crm reminder worker: vault secrets crm_project_url / crm_reminder_worker_secret are missing';
    return null;
  end if;

  select net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/reminder-worker',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    body := jsonb_build_object('source', 'pg_cron'),
    timeout_milliseconds := 25000
  ) into v_request_id;
  return v_request_id;
end $$;

-- Old link codes go with the daily retention job.
create or replace function private.cleanup_scheduler_logs()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.cleanup_reminder_data(90);
  delete from public.telegram_notifications
    where state in ('sent', 'failed', 'skipped', 'cancelled') and updated_at < now() - interval '90 days';
  delete from public.whatsapp_link_codes where expires_at < now() - interval '1 day';
  if to_regclass('cron.job_run_details') is not null then
    execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
  end if;
end $$;

-- ----- Privileges -------------------------------------------------------------
revoke all on function
  private.wa_window_open(timestamptz), private.notify_channel(uuid), private.channel_ready(uuid),
  private.set_notify_channel(uuid, text), private.release_held(uuid), private.note_whatsapp_paused(uuid),
  private.hold_reason(text), private.bot_summary(uuid)
from public, anon, authenticated;

revoke all on function
  public.claim_due_reminders(integer, integer),
  public.claim_due_notifications(integer, integer),
  public.finish_reminder(uuid, uuid, text, text, integer, bigint, text),
  public.finish_notification(uuid, uuid, text, text, integer, text),
  public.whatsapp_bot_summary(text),
  public.whatsapp_inbound(text, text),
  public.whatsapp_silence_nag(text, uuid),
  public.whatsapp_delivery_status(text, text, integer),
  public.claim_whatsapp_prompts(integer, boolean),
  public.create_whatsapp_link(),
  public.my_notify_channels(),
  public.set_notify_channel(text),
  public.disconnect_whatsapp(),
  public.super_whatsapp_status()
from public, anon, authenticated;

grant execute on function
  public.claim_due_reminders(integer, integer),
  public.claim_due_notifications(integer, integer),
  public.finish_reminder(uuid, uuid, text, text, integer, bigint, text),
  public.finish_notification(uuid, uuid, text, text, integer, text),
  public.whatsapp_bot_summary(text),
  public.whatsapp_inbound(text, text),
  public.whatsapp_silence_nag(text, uuid),
  public.whatsapp_delivery_status(text, text, integer)
  , public.claim_whatsapp_prompts(integer, boolean)
to service_role;

grant execute on function
  public.create_whatsapp_link(),
  public.my_notify_channels(),
  public.set_notify_channel(text),
  public.disconnect_whatsapp(),
  public.super_whatsapp_status()
to authenticated;
