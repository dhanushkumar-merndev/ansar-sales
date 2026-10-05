-- Simple CRM: Realtime publication and the minute-based reminder scheduler.
-- Both blocks are guarded so the migration also applies to plain PostgreSQL
-- (used by the automated tests), where these Supabase features do not exist.

-- Realtime: RLS-aware postgres_changes for the tables the UI listens to.
-- Telegram connections and reminder delivery internals are intentionally not published.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.leads,
      public.follow_ups,
      public.lead_activities,
      public.niches,
      public.profiles,
      public.capital_entries,
      public.expenses;
  end if;
end $$;

-- Calls the reminder-worker Edge Function through pg_net, only when work is due.
-- The project URL and worker secret are read from Supabase Vault at run time
-- (see README: "Reminder scheduler").
create function private.invoke_reminder_worker()
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

create function private.cleanup_scheduler_logs()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.cleanup_reminder_data(90);
  if to_regclass('cron.job_run_details') is not null then
    execute 'delete from cron.job_run_details where end_time < now() - interval ''7 days''';
  end if;
end $$;

revoke all on function private.invoke_reminder_worker() from public, anon, authenticated;
revoke all on function private.cleanup_scheduler_logs() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net;
    -- One job for all reminders (never one job per follow-up).
    perform cron.schedule('crm-reminder-worker', '* * * * *', 'select private.invoke_reminder_worker()');
    -- Daily retention at 03:17 UTC.
    perform cron.schedule('crm-retention', '17 3 * * *', 'select private.cleanup_scheduler_logs()');
  end if;
end $$;
