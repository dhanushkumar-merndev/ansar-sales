-- ---------------------------------------------------------------------------
-- In-app notifications (the bell), for every company. Every alert already goes through
-- private.enqueue_notification; it now also files an in-app item for the recipient — whether or not
-- they connected Telegram. Telegram and the bell have separate switches per kind
-- (notification_settings.disabled_kinds and muted_app_kinds). The app renders the text from
-- kind + payload with the worker's own logic, so both say the same thing.
--
-- Also: shared colours for the Projects page's year/month folders.
-- ---------------------------------------------------------------------------

create table public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 40),
  payload jsonb not null default '{}'::jsonb check (pg_column_size(payload) <= 20000),
  dedupe_key text not null check (char_length(dedupe_key) <= 300),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint app_notifications_dedupe_key unique (recipient_id, dedupe_key)
);
create index app_notifications_recipient_idx on public.app_notifications (recipient_id, created_at desc, id desc);
create index app_notifications_unread_idx on public.app_notifications (recipient_id) where read_at is null;

alter table public.app_notifications enable row level security;
create policy app_notifications_select on public.app_notifications for select to authenticated
  using (recipient_id = (select auth.uid()));
create policy app_notifications_update on public.app_notifications for update to authenticated
  using (recipient_id = (select auth.uid())) with check (recipient_id = (select auth.uid()));
revoke all on public.app_notifications from anon, authenticated;
grant select on public.app_notifications to authenticated;
grant update (read_at) on public.app_notifications to authenticated;

alter table public.notification_settings add column muted_app_kinds text[] not null default '{}';

-- Same checks as before for Telegram; the in-app item needs no Telegram connection. Overdue nags repeat
-- every 5 minutes on Telegram but are one item per follow-up revision in the app. Returns whether a
-- Telegram message was queued (callers count those).
create or replace function private.enqueue_notification(
  p_recipient uuid, p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null, p_follow_up_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_telegram boolean;
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
    and p_kind = any(private.notification_kinds_for_roles(p.role, p.extra_roles))
    and not (p_kind = any(coalesce(s.disabled_kinds, '{}')))
  on conflict do nothing;
  v_telegram := found;

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
  return v_telegram;
end $$;

-- Switches one kind on or off for one channel: 'telegram' (default, as before) or 'app'.
drop function public.set_notification_pref(text, boolean);
create function public.set_notification_pref(p_kind text, p_enabled boolean, p_channel text default 'telegram')
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_kinds text[];
  v_off text[];
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  if p_channel is null or p_channel not in ('telegram', 'app') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  select private.notification_kinds_for_roles(p.role, p.extra_roles) into v_kinds
  from public.profiles p where p.id = (select auth.uid());
  if p_kind is null or p_kind = 'test' or not (p_kind = any(v_kinds)) then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  insert into public.notification_settings (user_id) values ((select auth.uid())) on conflict (user_id) do nothing;
  if p_channel = 'telegram' then
    update public.notification_settings s set
      disabled_kinds = case when p_enabled then array_remove(s.disabled_kinds, p_kind)
                            when p_kind = any(s.disabled_kinds) then s.disabled_kinds else s.disabled_kinds || p_kind end,
      updated_at = now()
    where s.user_id = (select auth.uid()) returning s.disabled_kinds into v_off;
  else
    update public.notification_settings s set
      muted_app_kinds = case when p_enabled then array_remove(s.muted_app_kinds, p_kind)
                             when p_kind = any(s.muted_app_kinds) then s.muted_app_kinds else s.muted_app_kinds || p_kind end,
      updated_at = now()
    where s.user_id = (select auth.uid()) returning s.muted_app_kinds into v_off;
  end if;
  return v_off;
end $$;

-- The signed-in person's notifications, newest first, with the unread count.
create function public.my_notifications(p_unread_only boolean default false, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'payload', n.payload, 'created_at', n.created_at, 'read_at', n.read_at)
        order by n.created_at desc, n.id desc)
      from (select * from public.app_notifications x
            where x.recipient_id = v_uid and (not coalesce(p_unread_only, false) or x.read_at is null)
            order by x.created_at desc, x.id desc limit p_limit offset p_offset) n), '[]'::jsonb),
    'total', (select count(*) from public.app_notifications x where x.recipient_id = v_uid and (not coalesce(p_unread_only, false) or x.read_at is null)),
    'unread', (select count(*) from public.app_notifications x where x.recipient_id = v_uid and x.read_at is null));
end $$;

-- Marks some (or, with null, all) of the person's notifications read; returns how many are still unread.
create function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_left integer;
begin
  if v_uid is null or private.app_role() is null or cardinality(coalesce(p_ids, '{}')) > 200 then
    perform private.raise_forbidden();
  end if;
  update public.app_notifications n set read_at = now()
  where n.recipient_id = v_uid and n.read_at is null and (p_ids is null or n.id = any(p_ids));
  select count(*) into v_left from public.app_notifications n where n.recipient_id = v_uid and n.read_at is null;
  return v_left;
end $$;

-- Bounded retention: read items go after 60 days, everything after 180.
create function private.cleanup_app_notifications()
returns integer
language sql security definer set search_path = ''
as $$
  with gone as (
    delete from public.app_notifications
    where (read_at is not null and created_at < now() - interval '60 days') or created_at < now() - interval '180 days'
    returning 1)
  select count(*)::integer from gone
$$;

-- ---------------------------------------------------------------------------
-- Projects page: shared colours for the year and month folders (month null = the year folder).
-- ---------------------------------------------------------------------------
create table public.project_folder_colors (
  id uuid primary key default gen_random_uuid(),  -- Realtime publishes deletes, which needs a key
  company_id uuid not null references public.companies (id) on delete cascade,
  year integer not null check (year between 2000 and 2200),
  month integer check (month between 1 and 12),
  color text not null check (color ~ '^[a-z]{3,12}$'),
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);
create unique index project_folder_colors_key on public.project_folder_colors (company_id, year, coalesce(month, 0));

alter table public.project_folder_colors enable row level security;
create policy project_folder_colors_select on public.project_folder_colors for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.company_has('projects')));
revoke all on public.project_folder_colors from anon, authenticated;
grant select on public.project_folder_colors to authenticated;

-- Admins and architect managers set a folder's colour; null resets it to the default.
create function public.set_project_folder_color(p_year integer, p_month integer, p_color text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if v_company is null or not private.company_has('projects') or not (private.is_admin() or private.has_role('architect_manager')) then
    perform private.raise_forbidden();
  end if;
  if p_year is null or p_year not between 2000 and 2200 or (p_month is not null and p_month not between 1 and 12)
     or (p_color is not null and p_color !~ '^[a-z]{3,12}$') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  delete from public.project_folder_colors c where c.company_id = v_company and c.year = p_year and c.month is not distinct from p_month;
  if p_color is not null then
    insert into public.project_folder_colors (company_id, year, month, color, updated_by)
    values (v_company, p_year, p_month, p_color, (select auth.uid()));
  end if;
end $$;

revoke all on function public.set_notification_pref(text, boolean, text), public.my_notifications(boolean, integer, integer),
  public.mark_notifications_read(uuid[]), public.set_project_folder_color(integer, integer, text) from public, anon;
revoke all on function private.cleanup_app_notifications() from public, anon, authenticated;
grant execute on function public.set_notification_pref(text, boolean, text), public.my_notifications(boolean, integer, integer),
  public.mark_notifications_read(uuid[]), public.set_project_folder_color(integer, integer, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.app_notifications, public.project_folder_colors;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-app-notifications-cleanup', '17 3 * * *', 'select private.cleanup_app_notifications()');
  end if;
end $$;
