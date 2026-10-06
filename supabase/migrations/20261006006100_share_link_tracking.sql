-- One document link per lead, and a timeline of what happened to it.
--
-- * Sharing again adds documents to the lead's current link (same URL) and resets
--   its expiry; revoking ends it and the next share starts a new link.
-- * share_events records staff actions (link created, documents added/removed,
--   expiry changed, revoked) and customer actions (opened, viewed, downloaded).
--   Customer events are throttled and capped; no IP addresses are stored.
-- * The plain token is kept so the same URL can be sent again. It is never
--   selectable; only functions that check lead access return it.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------
alter table public.lead_shares
  add column token text unique check (token is null or token ~ '^[a-f0-9]{64}$'),
  add column updated_at timestamptz not null default now(),
  add column last_notified_on date;
grant select (updated_at) on public.lead_shares to authenticated;

alter table public.lead_share_files
  add column added_at timestamptz not null default now(),
  add column added_by uuid references public.profiles (id),
  add column removed_at timestamptz;

create type public.share_event_type as enum (
  'link_created', 'files_added', 'file_removed', 'opened', 'file_viewed', 'file_downloaded', 'expiry_changed', 'revoked'
);

create table public.share_events (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references public.lead_shares (id) on delete cascade,
  lead_id uuid not null references public.leads (id),
  type public.share_event_type not null,
  file_id uuid references public.library_files (id) on delete set null,
  file_name text check (file_name is null or char_length(file_name) <= 200),
  actor_id uuid references public.profiles (id),
  device text check (device is null or char_length(device) <= 60),
  meta jsonb not null default '{}'::jsonb,
  -- clock_timestamp: events written in one transaction keep their real order.
  created_at timestamptz not null default clock_timestamp()
);

create index share_events_lead_idx on public.share_events (lead_id, created_at desc, id desc);
create index share_events_share_idx on public.share_events (share_id, created_at desc);

alter table public.share_events enable row level security;
create policy share_events_select on public.share_events for select to authenticated
  using (private.can_access_lead(lead_id));
revoke all on public.share_events from anon, authenticated;
grant select on public.share_events to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Customer event with throttling: the same (type, file) within p_window is ignored,
-- and a link records at most 500 customer events per day.
create function private.record_customer_event(
  p_share uuid, p_lead uuid, p_type public.share_event_type, p_file uuid, p_file_name text, p_device text, p_window interval
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (
    select 1 from public.share_events e
    where e.share_id = p_share and e.type = p_type and e.file_id is not distinct from p_file
      and e.actor_id is null and e.created_at > now() - p_window
  ) then
    return false;
  end if;
  if (select count(*) from public.share_events e
      where e.share_id = p_share and e.actor_id is null and e.created_at > now() - interval '1 day') >= 500 then
    return false;
  end if;
  insert into public.share_events (share_id, lead_id, type, file_id, file_name, device)
  values (p_share, p_lead, p_type, p_file, p_file_name, nullif(left(btrim(coalesce(p_device, '')), 60), ''));
  return true;
end $$;

-- ---------------------------------------------------------------------------
-- Staff functions
-- ---------------------------------------------------------------------------
drop function public.create_lead_share(uuid, uuid[], text);

-- Adds documents to the lead's current link (creating it if needed) and resets its expiry.
create function public.share_lead_files(p_lead_id uuid, p_file_ids uuid[], p_expiry text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
  v_expires timestamptz;
  v_share public.lead_shares%rowtype;
  v_created boolean := false;
  v_token text;
  v_pos integer;
  v_added jsonb;
  v_was_expired boolean;
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.leads l where l.id = p_lead_id for update;
  if exists (select 1 from public.leads l where l.id = p_lead_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_expiry is null or p_expiry not in ('24h', '7d', '30d', 'never') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  v_expires := case p_expiry
    when '24h' then now() + interval '24 hours'
    when '7d' then now() + interval '7 days'
    when '30d' then now() + interval '30 days'
  end;

  v_count := coalesce(cardinality(p_file_ids), 0);
  if v_count < 1 or v_count > 10 or (select count(distinct x) from unnest(p_file_ids) x) <> v_count then
    raise exception 'invalid_share_files' using errcode = '22023';
  end if;
  if (
    select count(*) from public.library_files f
    join public.library_folders d on d.id = f.folder_id
    where f.id = any (p_file_ids) and f.archived_at is null and d.archived_at is null
  ) <> v_count then
    raise exception 'share_file_unavailable' using errcode = 'P0002';
  end if;

  select * into v_share from public.lead_shares s
  where s.lead_id = p_lead_id and s.revoked_at is null and s.token is not null
  order by s.created_at desc, s.id desc
  limit 1
  for update;

  if not found then
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into public.lead_shares (lead_id, token_hash, token, created_by, expires_at)
    values (p_lead_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_token, v_uid, v_expires)
    returning * into v_share;
    v_created := true;
    insert into public.share_events (share_id, lead_id, type, actor_id, meta)
    values (v_share.id, p_lead_id, 'link_created', v_uid, jsonb_build_object('expires_at', v_expires));
  else
    v_was_expired := v_share.expires_at is not null and v_share.expires_at <= now();
    if v_was_expired or (v_share.expires_at is null) <> (v_expires is null) then
      insert into public.share_events (share_id, lead_id, type, actor_id, meta)
      values (v_share.id, p_lead_id, 'expiry_changed', v_uid,
        jsonb_build_object('from', v_share.expires_at, 'to', v_expires, 'revived', v_was_expired));
    end if;
    update public.lead_shares set expires_at = v_expires, updated_at = now() where id = v_share.id;
  end if;

  select coalesce(max(sf.position), 0) into v_pos from public.lead_share_files sf where sf.share_id = v_share.id;
  with ins as (
    insert into public.lead_share_files as sf (share_id, file_id, position, added_at, added_by)
    select v_share.id, x.id, (v_pos + x.ord)::smallint, now(), v_uid
    from unnest(p_file_ids) with ordinality as x(id, ord)
    on conflict (share_id, file_id) do update
      set removed_at = null, added_at = now(), added_by = excluded.added_by
      where sf.removed_at is not null
    returning sf.file_id
  )
  select jsonb_agg(f.name order by f.name) into v_added
  from ins join public.library_files f on f.id = ins.file_id;

  if (select count(*) from public.lead_share_files sf where sf.share_id = v_share.id and sf.removed_at is null) > 50 then
    raise exception 'share_link_full' using errcode = '22023';
  end if;

  if v_added is not null then
    insert into public.share_events (share_id, lead_id, type, actor_id, meta)
    values (v_share.id, p_lead_id, 'files_added', v_uid, jsonb_build_object('files', v_added, 'expires_at', v_expires));
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (p_lead_id, v_uid, 'files_shared', jsonb_build_object('share_id', v_share.id, 'files', v_added, 'expires_at', v_expires));
  end if;

  return jsonb_build_object(
    'share_id', v_share.id, 'token', v_share.token, 'expires_at', v_expires,
    'created', v_created, 'added', coalesce(jsonb_array_length(v_added), 0)
  );
end $$;

-- The lead's current link (with its token, for Copy / Send again), its documents with
-- per-document customer activity, and any older links from before one-link-per-lead.
create function public.lead_share_summary(p_lead_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_share public.lead_shares%rowtype;
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_share from public.lead_shares s
  where s.lead_id = p_lead_id and s.revoked_at is null and s.token is not null
  order by s.created_at desc, s.id desc
  limit 1;

  return jsonb_build_object(
    'link', case when v_share.id is null then null else jsonb_build_object(
      'share_id', v_share.id, 'token', v_share.token, 'created_at', v_share.created_at,
      'expires_at', v_share.expires_at, 'view_count', v_share.view_count, 'last_viewed_at', v_share.last_viewed_at
    ) end,
    'files', case when v_share.id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'mime_type', f.mime_type, 'thumb_path', f.thumb_path, 'added_at', sf.added_at,
        'available', f.archived_at is null and d.archived_at is null,
        'views', (select count(*) from public.share_events e where e.share_id = v_share.id and e.file_id = f.id and e.type = 'file_viewed'),
        'downloads', (select count(*) from public.share_events e where e.share_id = v_share.id and e.file_id = f.id and e.type = 'file_downloaded'),
        'last_seen', (select max(e.created_at) from public.share_events e where e.share_id = v_share.id and e.file_id = f.id and e.type in ('file_viewed', 'file_downloaded'))
      ) order by sf.position)
      from public.lead_share_files sf
      join public.library_files f on f.id = sf.file_id
      join public.library_folders d on d.id = f.folder_id
      where sf.share_id = v_share.id and sf.removed_at is null
    ), '[]'::jsonb) end,
    'older_links', coalesce((
      select jsonb_agg(jsonb_build_object('share_id', s.id, 'created_at', s.created_at, 'expires_at', s.expires_at) order by s.created_at desc)
      from public.lead_shares s
      where s.lead_id = p_lead_id and s.revoked_at is null and s.token is null
        and (s.expires_at is null or s.expires_at > now())
    ), '[]'::jsonb)
  );
end $$;

create function public.remove_share_file(p_share_id uuid, p_file_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_share public.lead_shares%rowtype;
  v_name text;
begin
  select * into v_share from public.lead_shares s where s.id = p_share_id;
  if not found or not private.is_lead_user() or not private.can_access_lead(v_share.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.lead_share_files sf set removed_at = now()
  where sf.share_id = p_share_id and sf.file_id = p_file_id and sf.removed_at is null;
  if not found then
    return;
  end if;
  select f.name into v_name from public.library_files f where f.id = p_file_id;
  insert into public.share_events (share_id, lead_id, type, file_id, file_name, actor_id)
  values (p_share_id, v_share.lead_id, 'file_removed', p_file_id, v_name, (select auth.uid()));
end $$;

create or replace function public.revoke_lead_share(p_share_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_share public.lead_shares%rowtype;
begin
  select * into v_share from public.lead_shares s where s.id = p_share_id;
  if not found or not private.is_lead_user() or not private.can_access_lead(v_share.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_share.revoked_at is not null then
    return;
  end if;
  update public.lead_shares set revoked_at = now(), revoked_by = (select auth.uid()), updated_at = now() where id = v_share.id;
  insert into public.share_events (share_id, lead_id, type, actor_id)
  values (v_share.id, v_share.lead_id, 'revoked', (select auth.uid()));
  insert into public.lead_activities (lead_id, actor_id, type, meta)
  values (v_share.lead_id, (select auth.uid()), 'share_revoked',
    jsonb_build_object('share_id', v_share.id, 'shared_at', v_share.created_at));
end $$;

-- ---------------------------------------------------------------------------
-- Public (customer) functions
-- ---------------------------------------------------------------------------
drop function public.open_lead_share(text, boolean);

-- Public share page. Null for an unknown, expired or revoked token. Records the open
-- (throttled), adds a main-timeline entry on the very first open, and tells the page
-- to notify the owner on the first open of each IST day.
create function public.open_lead_share(p_token text, p_count_view boolean default true, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_share public.lead_shares%rowtype;
  v_notify boolean := false;
begin
  select * into v_share from public.lead_shares s where s.id = private.live_share_id(p_token) for update;
  if not found then
    return null;
  end if;
  if coalesce(p_count_view, true) then
    if v_share.view_count = 0 then
      insert into public.lead_activities (lead_id, actor_id, type, meta)
      values (v_share.lead_id, null, 'share_opened',
        jsonb_build_object('share_id', v_share.id, 'device', nullif(left(btrim(coalesce(p_device, '')), 60), '')));
    end if;
    v_notify := v_share.last_notified_on is distinct from private.ist_today();
    update public.lead_shares
    set view_count = view_count + 1, last_viewed_at = now(),
        last_notified_on = case when v_notify then private.ist_today() else last_notified_on end
    where id = v_share.id;
    perform private.record_customer_event(v_share.id, v_share.lead_id, 'opened', null, null, p_device, interval '30 minutes');
  end if;
  return jsonb_build_object(
    'shared_by', private.display_name(v_share.created_by),
    'created_at', v_share.created_at,
    'expires_at', v_share.expires_at,
    'notify_share_id', case when v_notify then v_share.id end,
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes,
        'has_preview', f.thumb_path is not null or f.mime_type like 'image/%'
      ) order by sf.position)
      from public.lead_share_files sf
      join public.library_files f on f.id = sf.file_id
      join public.library_folders d on d.id = f.folder_id
      where sf.share_id = v_share.id and sf.removed_at is null and f.archived_at is null and d.archived_at is null
    ), '[]'::jsonb)
  );
end $$;

-- Untracked file location (previews and thumbnails on the page).
create or replace function public.resolve_share_file(p_token text, p_file_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('storage_path', f.storage_path, 'thumb_path', f.thumb_path, 'name', f.name, 'mime_type', f.mime_type)
  from public.lead_share_files sf
  join public.library_files f on f.id = sf.file_id
  join public.library_folders d on d.id = f.folder_id
  where sf.share_id = private.live_share_id(p_token)
    and sf.file_id = p_file_id and sf.removed_at is null
    and f.archived_at is null and d.archived_at is null
$$;

-- The customer opened (view) or downloaded one document: record it (throttled) and
-- return its location.
create function public.track_share_file(p_token text, p_file_id uuid, p_kind text, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_share_id uuid := private.live_share_id(p_token);
  v_lead uuid;
  v_file public.library_files%rowtype;
begin
  if v_share_id is null or p_kind is null or p_kind not in ('view', 'download') then
    return null;
  end if;
  select f.* into v_file
  from public.lead_share_files sf
  join public.library_files f on f.id = sf.file_id
  join public.library_folders d on d.id = f.folder_id
  where sf.share_id = v_share_id and sf.file_id = p_file_id and sf.removed_at is null
    and f.archived_at is null and d.archived_at is null;
  if not found then
    return null;
  end if;
  select s.lead_id into v_lead from public.lead_shares s where s.id = v_share_id;
  perform private.record_customer_event(v_share_id, v_lead,
    case p_kind when 'download' then 'file_downloaded' else 'file_viewed' end::public.share_event_type,
    v_file.id, v_file.name, p_device, interval '2 minutes');
  return jsonb_build_object('storage_path', v_file.storage_path, 'name', v_file.name, 'mime_type', v_file.mime_type);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges and Realtime
-- ---------------------------------------------------------------------------
revoke all on function
  private.record_customer_event(uuid, uuid, public.share_event_type, uuid, text, text, interval),
  public.share_lead_files(uuid, uuid[], text),
  public.lead_share_summary(uuid),
  public.remove_share_file(uuid, uuid),
  public.open_lead_share(text, boolean, text),
  public.track_share_file(text, uuid, text, text)
from public, anon;

grant execute on function
  public.share_lead_files(uuid, uuid[], text),
  public.lead_share_summary(uuid),
  public.remove_share_file(uuid, uuid)
to authenticated;

grant execute on function
  public.open_lead_share(text, boolean, text),
  public.track_share_file(text, uuid, text, text)
to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.share_events;
  end if;
end $$;
