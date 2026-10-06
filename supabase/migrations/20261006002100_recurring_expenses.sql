-- Monthly recurring expenses: a template per series; an hourly job adds the next month's expense on the same
-- day (clamped to the month's last day) and queues a Telegram notification for connected Admin/Account users.

create table public.expense_recurrences (
  id uuid primary key default gen_random_uuid(),
  category public.expense_category not null,
  amount numeric(14, 2) not null check (amount > 0),
  payment_mode text check (payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  item text check (item is null or char_length(btrim(item)) between 1 and 120),
  quantity integer check (quantity is null or quantity between 1 and 1000000),
  description text check (description is null or char_length(description) <= 500),
  day_of_month smallint not null check (day_of_month between 1 and 31),
  next_date date not null,
  active boolean not null default true,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index expense_recurrences_due_idx on public.expense_recurrences (next_date) where active;

alter table public.expenses add column recurrence_id uuid references public.expense_recurrences (id);
create unique index expenses_recurrence_date_key on public.expenses (recurrence_id, expense_date) where recurrence_id is not null;

alter table public.expense_recurrences enable row level security;
create policy expense_recurrences_select on public.expense_recurrences for select to authenticated
  using ((select private.is_finance_user()));
grant select on public.expense_recurrences to authenticated;

-- Telegram notifications other than follow-up reminders. Service role only (no policies).
create table public.telegram_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('recurring_expense')),
  payload jsonb not null,
  dedupe_key text not null,
  state public.reminder_state not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  sent_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_notifications_dedupe_key unique (recipient_id, dedupe_key)
);

create index telegram_notifications_due_idx on public.telegram_notifications (next_attempt_at, id) where state in ('pending', 'processing');
alter table public.telegram_notifications enable row level security;

create trigger telegram_notifications_touch before update on public.telegram_notifications
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Scheduling helpers
-- ---------------------------------------------------------------------------

-- The given day of the month after `p_date`, clamped to that month's last day (31 → 30 Nov, 28/29 Feb).
create function private.next_month_on_day(p_date date, p_day integer)
returns date
language sql immutable set search_path = ''
as $$
  select (date_trunc('month', p_date) + interval '1 month')::date
    + (least(p_day, extract(day from date_trunc('month', p_date) + interval '2 month - 1 day')::integer) - 1)
$$;

-- Turns monthly repetition on or off for an expense's series, using that expense as the template.
create function public.set_expense_recurrence(p_expense_id uuid, p_repeat boolean)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  e public.expenses%rowtype;
  v_last date;
  v_id uuid;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  select * into e from public.expenses x where x.id = p_expense_id and x.archived_at is null for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not coalesce(p_repeat, false) then
    update public.expense_recurrences set active = false, updated_at = now() where id = e.recurrence_id;
    return e.recurrence_id;
  end if;

  if e.recurrence_id is null then
    insert into public.expense_recurrences (category, amount, payment_mode, item, quantity, description, day_of_month, next_date, created_by)
    values (e.category, e.amount, e.payment_mode, e.item, e.quantity, e.description, extract(day from e.expense_date)::smallint,
      private.next_month_on_day(e.expense_date, extract(day from e.expense_date)::integer), v_uid)
    returning id into v_id;
    update public.expenses set recurrence_id = v_id where id = e.id;
    return v_id;
  end if;

  -- Existing series: this expense becomes the template; the next date follows the series' latest expense.
  select max(x.expense_date) into v_last from public.expenses x where x.recurrence_id = e.recurrence_id;
  update public.expense_recurrences set
    category = e.category, amount = e.amount, payment_mode = e.payment_mode, item = e.item, quantity = e.quantity,
    description = e.description, day_of_month = extract(day from e.expense_date)::smallint,
    next_date = private.next_month_on_day(v_last, extract(day from e.expense_date)::integer),
    active = true, updated_at = now()
  where id = e.recurrence_id;
  return e.recurrence_id;
end $$;

-- Adds every due monthly expense (catching up at most 12 months per series per run) and queues notifications.
create function private.generate_recurring_expenses()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  r public.expense_recurrences%rowtype;
  v_date date;
  v_expense uuid;
  v_added integer := 0;
  v_runs integer;
begin
  for r in
    select * from public.expense_recurrences x where x.active and x.next_date <= v_today
    order by x.next_date, x.id for update skip locked
  loop
    v_date := r.next_date;
    v_runs := 0;
    while v_date <= v_today and v_runs < 12 loop
      v_expense := null;
      insert into public.expenses (expense_date, category, amount, payment_mode, item, quantity, description, created_by, recurrence_id)
      values (v_date, r.category, r.amount, r.payment_mode, r.item, r.quantity, r.description, r.created_by, r.id)
      on conflict (recurrence_id, expense_date) where recurrence_id is not null do nothing
      returning id into v_expense;

      if v_expense is not null then
        v_added := v_added + 1;
        insert into public.telegram_notifications (recipient_id, kind, payload, dedupe_key)
        select p.id, 'recurring_expense',
          jsonb_build_object('expense_id', v_expense, 'date', v_date, 'category', r.category, 'amount', r.amount,
            'item', r.item, 'quantity', r.quantity, 'payment_mode', r.payment_mode, 'description', r.description),
          'recurring_expense:' || v_expense
        from public.profiles p
        join public.telegram_connections t on t.user_id = p.id and t.status = 'connected'
        where p.is_active and p.role in ('admin', 'account')
        on conflict do nothing;
      end if;

      v_date := private.next_month_on_day(v_date, r.day_of_month);
      v_runs := v_runs + 1;
    end loop;
    update public.expense_recurrences set next_date = v_date, updated_at = now() where id = r.id;
  end loop;
  return v_added;
end $$;

-- ---------------------------------------------------------------------------
-- Notification worker RPCs (service role only), same lease/retry rules as reminders.
-- ---------------------------------------------------------------------------
create function public.claim_due_notifications(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (notification_id uuid, lease_token uuid, chat_id bigint, kind text, payload jsonb, attempts integer)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_max_attempts constant integer := 5;
  r record;
  v_token uuid;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  for r in
    select n.id, n.kind, n.payload, n.attempts, p.is_active, p.role, t.chat_id as t_chat, t.status as t_status
    from public.telegram_notifications n
    join public.profiles p on p.id = n.recipient_id
    left join public.telegram_connections t on t.user_id = n.recipient_id
    where n.state in ('pending', 'processing') and n.next_attempt_at <= now()
    order by n.next_attempt_at, n.id
    limit p_limit
    for update of n skip locked
  loop
    if not r.is_active or r.role not in ('admin', 'account') then
      update public.telegram_notifications set state = 'skipped', last_error = 'recipient_inactive', lease_token = null where id = r.id;
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

create function public.finish_notification(p_id uuid, p_lease_token uuid, p_result text, p_error text default null, p_retry_after_seconds integer default null)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_row public.telegram_notifications%rowtype;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
begin
  if p_result not in ('sent', 'retry', 'failed', 'blocked') then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  select * into v_row from public.telegram_notifications n
    where n.id = p_id and n.lease_token = p_lease_token and n.state = 'processing' for update;
  if not found then
    return 'lease_lost';
  end if;
  if p_result = 'sent' then
    update public.telegram_notifications set state = 'sent', sent_at = now(), last_error = null, lease_token = null where id = v_row.id;
    return 'sent';
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
    update public.telegram_connections set status = 'blocked', last_error = v_error where user_id = v_row.recipient_id;
  end if;
  return 'failed';
end $$;

-- The worker is now also invoked when notifications are due.
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

create or replace function private.cleanup_scheduler_logs()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.cleanup_reminder_data(90);
  delete from public.telegram_notifications
    where state in ('sent', 'failed', 'skipped', 'cancelled') and updated_at < now() - interval '90 days';
  if to_regclass('cron.job_run_details') is not null then
    execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
  end if;
end $$;

revoke all on function private.generate_recurring_expenses() from public, anon, authenticated;
revoke all on function public.set_expense_recurrence(uuid, boolean) from public, anon;
grant execute on function public.set_expense_recurrence(uuid, boolean) to authenticated;
revoke all on function public.claim_due_notifications(integer, integer) from public, anon, authenticated;
revoke all on function public.finish_notification(uuid, uuid, text, text, integer) from public, anon, authenticated;
grant execute on function public.claim_due_notifications(integer, integer), public.finish_notification(uuid, uuid, text, text, integer) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Hourly at :07; one job for every series.
    perform cron.schedule('crm-recurring-expenses', '7 * * * *', 'select private.generate_recurring_expenses()');
  end if;
end $$;
