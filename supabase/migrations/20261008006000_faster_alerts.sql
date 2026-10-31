-- Faster phone alerts, no stale floods, smarter WhatsApp nudges.
--
-- 1. Late alerts are dropped. An event alert more than 6 hours late (a lead created, a file added, a digest)
--    is noise, so the worker never sends it; it ends as skipped / 'stale'. This also clears the backlog that
--    built up while the worker could not run. Follow-up reminders are not touched.
-- 2. Speed. The worker check runs every 15 seconds instead of every minute (still only calling the Edge Function
--    when something is due), and a new alert wakes the worker straight away (at most once every 2 seconds).
-- 3. WhatsApp nudge. Up to 2 hours before the 24-hour window closes, only between 08:00 and 22:00 IST; a window
--    that would close overnight is nudged the evening before. The worker also learns when the window closes and
--    how many follow-ups are due after that, so the message can say so.

-- ----- 1. Drop alerts that are too late to be useful ------------------------------------------------------
create function private.expire_stale_alerts()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  -- Held WhatsApp alerts have a future next_attempt_at (their own 3-day rule), and released ones are
  -- set to now(), so neither matches.
  update public.telegram_notifications
    set state = 'skipped', last_error = 'stale', lease_token = null
    where state = 'pending' and next_attempt_at < now() - interval '6 hours';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

select private.expire_stale_alerts();

-- ----- 3. When to nudge (shared by the worker gate and the claim) -------------------------------------------
create function private.wa_nudge_due(p_last timestamptz, p_nudged timestamptz, p_now timestamptz default now())
returns boolean
language sql stable set search_path = ''
as $$
  select p_last is not null
    and (p_nudged is null or p_nudged < p_last)
    -- still open long enough to deliver
    and p_last + interval '23 hours 55 minutes' > p_now + interval '5 minutes'
    -- daytime only
    and extract(hour from p_now at time zone 'Asia/Kolkata') between 8 and 21
    and (
      p_last + interval '23 hours 55 minutes' <= p_now + interval '2 hours'
      -- closes overnight (before 09:30 tomorrow): ask in the evening
      or (extract(hour from p_now at time zone 'Asia/Kolkata') >= 20
          and p_last + interval '23 hours 55 minutes'
            <= (((p_now at time zone 'Asia/Kolkata')::date + 1) + time '09:30') at time zone 'Asia/Kolkata')
    )
$$;

drop function public.claim_whatsapp_prompts(integer, boolean);
create function public.claim_whatsapp_prompts(p_limit integer default 25, p_reopen boolean default false, p_now timestamptz default now())
returns table (user_id uuid, wa_id text, kind text, name text, held integer, window_until timestamptz, upcoming integer)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  r record;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  for r in
    select w.user_id as u, w.wa_id as wid, p.display_name as dn, w.last_inbound_at + interval '23 hours 55 minutes' as until
    from public.whatsapp_connections w
    join public.profiles p on p.id = w.user_id and p.is_active
    join public.notification_settings s on s.user_id = w.user_id and s.channel = 'whatsapp'
    where w.status = 'connected' and private.wa_nudge_due(w.last_inbound_at, w.nudged_at, p_now)
    order by w.last_inbound_at
    limit p_limit
    for update of w skip locked
  loop
    update public.whatsapp_connections set nudged_at = p_now where whatsapp_connections.user_id = r.u;
    user_id := r.u; wa_id := r.wid; kind := 'nudge'; name := r.dn; held := 0; window_until := r.until;
    -- Follow-up reminders that would land after the window closes (within the next day).
    select count(*)::integer into upcoming from public.reminder_deliveries d
      where d.recipient_id = r.u and d.state = 'pending' and d.due_at >= r.until and d.due_at < p_now + interval '24 hours';
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
      update public.whatsapp_connections set reopen_sent_at = p_now where whatsapp_connections.user_id = r.u;
      user_id := r.u; wa_id := r.wid; kind := 'reopen'; name := r.dn; held := r.h; window_until := null; upcoming := 0;
      return next;
    end loop;
  end if;
end $$;

revoke all on function public.claim_whatsapp_prompts(integer, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_prompts(integer, boolean, timestamptz) to service_role;

-- ----- 2. The worker gate (latest: 20261008005800) now drops stale alerts first and uses the nudge rule -------
create or replace function private.invoke_reminder_worker()
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  perform private.expire_stale_alerts();
  if not exists (
    select 1 from public.reminder_deliveries d
    where d.state in ('pending', 'processing') and d.next_attempt_at <= now()
  ) and not exists (
    select 1 from public.telegram_notifications n
    where n.state in ('pending', 'processing') and n.next_attempt_at <= now()
  ) and not exists (
    select 1 from public.whatsapp_connections w
    join public.notification_settings s on s.user_id = w.user_id and s.channel = 'whatsapp'
    where w.status = 'connected' and private.wa_nudge_due(w.last_inbound_at, w.nudged_at)
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

-- ----- 2. Wake the worker as soon as an alert is queued ---------------------------------------------------
create table private.worker_kick (
  id integer primary key check (id = 1),
  last_at timestamptz not null default '-infinity'
);
insert into private.worker_kick (id) values (1);

-- pg_net sends the request only after this transaction commits, so the worker sees the new rows.
-- Concurrent inserts skip the locked row instead of waiting on it; the 15-second check covers them.
create function private.kick_reminder_worker()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform 1 from private.worker_kick where id = 1 and last_at < now() - interval '2 seconds' for update skip locked;
  if found then
    update private.worker_kick set last_at = now() where id = 1;
    perform private.invoke_reminder_worker();
  end if;
end $$;

create function private.kick_on_new_alert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from new_rows where state = 'pending' and next_attempt_at <= now()) then
    perform private.kick_reminder_worker();
  end if;
  return null;
end $$;

create trigger telegram_notifications_kick after insert on public.telegram_notifications
  referencing new table as new_rows
  for each statement execute function private.kick_on_new_alert();

-- Alerts released by a WhatsApp message (latest: 20261008005800) go out at once too.
create or replace function private.release_held(p_user uuid)
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
  if v_a + v_b > 0 then
    perform private.kick_reminder_worker();
  end if;
  return v_a + v_b;
end $$;

revoke all on function private.expire_stale_alerts() from public, anon, authenticated;
revoke all on function private.wa_nudge_due(timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function private.kick_reminder_worker() from public, anon, authenticated;
revoke all on function private.kick_on_new_alert() from public, anon, authenticated;
revoke all on table private.worker_kick from public, anon, authenticated;

-- ----- 2. Check every 15 seconds (cheap: the Edge Function is only called when something is due) ----------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-reminder-worker', '15 seconds', 'select private.invoke_reminder_worker()');
  end if;
end $$;
