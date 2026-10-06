-- Library (shared sales material in a private Storage bucket), call logging, and
-- lead shares: tokenised public links that let one customer open selected files.
--
-- Access: Admin and Sales read the library, create folders and upload; only Admin
-- renames/archives. Account has no access. Share links are created only for a lead
-- the caller can access; the public page reaches data only through two narrow
-- security-definer functions that validate the token.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.library_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  normalized_name text generated always as (
    lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
  ) stored,
  created_by uuid not null references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);

create unique index library_folders_active_name_key on public.library_folders (normalized_name) where archived_at is null;
create index library_folders_name_idx on public.library_folders (normalized_name, id);

create table public.library_files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.library_folders (id),
  name text not null check (char_length(name) between 1 and 200),
  normalized_name text generated always as (lower(name)) stored,
  storage_path text not null unique check (char_length(storage_path) <= 300),
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  created_by uuid not null references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);

create index library_files_folder_idx on public.library_files (folder_id, created_at desc, id desc);
create index library_files_name_idx on public.library_files (normalized_name, id) where archived_at is null;

create table public.lead_shares (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  view_count integer not null default 0,
  last_viewed_at timestamptz
);

create index lead_shares_lead_idx on public.lead_shares (lead_id, created_at desc, id desc);

create table public.lead_share_files (
  share_id uuid not null references public.lead_shares (id) on delete cascade,
  file_id uuid not null references public.library_files (id),
  position smallint not null,
  primary key (share_id, file_id)
);

create index lead_share_files_file_idx on public.lead_share_files (file_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create function private.library_folders_before_write()
returns trigger
language plpgsql
as $$
begin
  new.name := private.clean_label(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
    new.archived_at := null;
    new.archived_by := null;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := (select auth.uid());
    if new.archived_at is distinct from old.archived_at then
      new.archived_by := case when new.archived_at is null then null else (select auth.uid()) end;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger library_folders_before_write before insert or update on public.library_folders
  for each row execute function private.library_folders_before_write();

-- Security definer only to read storage.objects: a file row can be registered only
-- for an object that was really uploaded into its folder, and the stored size/type
-- come from Storage's own metadata rather than the client.
create function private.library_files_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_meta jsonb;
begin
  new.name := private.clean_label(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
    new.archived_at := null;
    new.archived_by := null;
    if not exists (select 1 from public.library_folders f where f.id = new.folder_id and f.archived_at is null) then
      raise exception 'folder_not_found' using errcode = 'P0002';
    end if;
    if new.storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp)$'
       or split_part(new.storage_path, '/', 1) <> new.folder_id::text then
      raise exception 'invalid_file' using errcode = '22023';
    end if;
    select o.metadata into v_meta from storage.objects o where o.bucket_id = 'library' and o.name = new.storage_path;
    if not found then
      raise exception 'file_not_uploaded' using errcode = 'P0002';
    end if;
    new.size_bytes := coalesce((v_meta ->> 'size')::bigint, 0);
    new.mime_type := coalesce(v_meta ->> 'mimetype', '');
    if new.mime_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
      raise exception 'invalid_file_type' using errcode = '22023';
    end if;
  else
    new.folder_id := old.folder_id;
    new.storage_path := old.storage_path;
    new.mime_type := old.mime_type;
    new.size_bytes := old.size_bytes;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := (select auth.uid());
    if new.archived_at is distinct from old.archived_at then
      new.archived_by := case when new.archived_at is null then null else (select auth.uid()) end;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger library_files_before_write before insert or update on public.library_files
  for each row execute function private.library_files_before_write();

-- ---------------------------------------------------------------------------
-- Storage bucket and object policies
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('library', 'library', false, 26214400, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy library_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'library' and (select private.is_lead_user()));
-- Uploads only into an active folder. No update/delete: files are archived in
-- library_files instead, so existing share links keep a consistent history.
create policy library_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'library'
    and (select private.is_lead_user())
    and exists (
      select 1 from public.library_folders f
      where f.id::text = (storage.foldername(objects.name))[1] and f.archived_at is null
    )
  );

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- ---------------------------------------------------------------------------
alter table public.library_folders enable row level security;
alter table public.library_files enable row level security;
alter table public.lead_shares enable row level security;
alter table public.lead_share_files enable row level security;

create policy library_folders_select on public.library_folders for select to authenticated
  using ((select private.is_lead_user()));
create policy library_folders_insert on public.library_folders for insert to authenticated
  with check ((select private.is_lead_user()) and created_by = (select auth.uid()));
create policy library_folders_update on public.library_folders for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy library_files_select on public.library_files for select to authenticated
  using ((select private.is_lead_user()));
create policy library_files_insert on public.library_files for insert to authenticated
  with check ((select private.is_lead_user()) and created_by = (select auth.uid()));
create policy library_files_update on public.library_files for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy lead_shares_select on public.lead_shares for select to authenticated
  using (private.can_access_lead(lead_id));
create policy lead_share_files_select on public.lead_share_files for select to authenticated
  using (exists (select 1 from public.lead_shares s where s.id = share_id and private.can_access_lead(s.lead_id)));
-- Shares are written only through the functions below.

revoke all on public.library_folders, public.library_files, public.lead_shares, public.lead_share_files from anon, authenticated;
grant select on public.library_folders to authenticated;
grant insert (name) on public.library_folders to authenticated;
grant update (name, archived_at) on public.library_folders to authenticated;
grant select on public.library_files to authenticated;
grant insert (folder_id, name, storage_path) on public.library_files to authenticated;
grant update (name, archived_at) on public.library_files to authenticated;
-- token_hash is never readable.
grant select (id, lead_id, created_by, created_at, expires_at, revoked_at, revoked_by, view_count, last_viewed_at)
  on public.lead_shares to authenticated;
grant select on public.lead_share_files to authenticated;

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------
create function public.log_call(p_lead_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
  v_id uuid;
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_lead from public.leads l where l.id = p_lead_id;
  if v_lead.archived_at is not null then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  insert into public.lead_activities (lead_id, actor_id, type, meta)
  values (p_lead_id, (select auth.uid()), 'call_logged', jsonb_build_object('phone', v_lead.phone))
  returning id into v_id;
  return v_id;
end $$;

-- The caller's own call, within a day: records (or corrects) its outcome and note.
create function public.set_call_outcome(p_activity_id uuid, p_outcome text, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_call public.lead_activities%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_outcome is null or p_outcome not in ('connected', 'no_answer', 'busy', 'wrong_number') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  select * into v_call from public.lead_activities a where a.id = p_activity_id and a.type = 'call_logged';
  if not found or v_call.actor_id is distinct from (select auth.uid()) or not private.can_access_lead(v_call.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_call.created_at < now() - interval '24 hours' then
    raise exception 'call_outcome_closed' using errcode = '22023';
  end if;
  update public.lead_activities
  set meta = v_call.meta || jsonb_build_object('outcome', p_outcome),
      body = v_note,
      edited_at = case when v_call.meta ? 'outcome' then now() else null end
  where id = v_call.id;
end $$;

-- ---------------------------------------------------------------------------
-- Lead shares
-- ---------------------------------------------------------------------------

-- Returns a token once; only its SHA-256 hash is stored.
create function public.create_lead_share(p_lead_id uuid, p_file_ids uuid[], p_expiry text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
  v_expires timestamptz;
  v_token text;
  v_share uuid;
  v_names jsonb;
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
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

  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.lead_shares (lead_id, token_hash, created_by, expires_at)
  values (p_lead_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_uid, v_expires)
  returning id into v_share;

  insert into public.lead_share_files (share_id, file_id, position)
  select v_share, x.id, x.ord::smallint from unnest(p_file_ids) with ordinality as x(id, ord);

  select jsonb_agg(f.name order by x.ord) into v_names
  from unnest(p_file_ids) with ordinality as x(id, ord)
  join public.library_files f on f.id = x.id;

  insert into public.lead_activities (lead_id, actor_id, type, meta)
  values (p_lead_id, v_uid, 'files_shared', jsonb_build_object('share_id', v_share, 'files', v_names, 'expires_at', v_expires));

  return jsonb_build_object('share_id', v_share, 'token', v_token, 'expires_at', v_expires);
end $$;

create function public.revoke_lead_share(p_share_id uuid)
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
  update public.lead_shares set revoked_at = now(), revoked_by = (select auth.uid()) where id = v_share.id;
  insert into public.lead_activities (lead_id, actor_id, type, meta)
  values (v_share.lead_id, (select auth.uid()), 'share_revoked',
    jsonb_build_object('share_id', v_share.id, 'shared_at', v_share.created_at));
end $$;

-- Id of a share whose token is valid right now (not revoked/expired, lead not archived).
create function private.live_share_id(p_token text)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select s.id from public.lead_shares s
  join public.leads l on l.id = s.lead_id
  where p_token ~ '^[a-f0-9]{64}$'
    and s.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
    and l.archived_at is null
$$;

-- Public share page. Returns null for an unknown, expired or revoked token.
-- Exposes no customer details: only the sender's display name and the files.
create function public.open_lead_share(p_token text, p_count_view boolean default true)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_share public.lead_shares%rowtype;
begin
  select * into v_share from public.lead_shares s where s.id = private.live_share_id(p_token);
  if not found then
    return null;
  end if;
  if coalesce(p_count_view, true) then
    update public.lead_shares set view_count = view_count + 1, last_viewed_at = now() where id = v_share.id;
  end if;
  return jsonb_build_object(
    'shared_by', private.display_name(v_share.created_by),
    'created_at', v_share.created_at,
    'expires_at', v_share.expires_at,
    'files', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes) order by sf.position)
      from public.lead_share_files sf
      join public.library_files f on f.id = sf.file_id
      join public.library_folders d on d.id = f.folder_id
      where sf.share_id = v_share.id and f.archived_at is null and d.archived_at is null
    ), '[]'::jsonb)
  );
end $$;

-- Storage location of one file in a live share (used to mint a short-lived signed URL).
create function public.resolve_share_file(p_token text, p_file_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('storage_path', f.storage_path, 'name', f.name, 'mime_type', f.mime_type)
  from public.lead_share_files sf
  join public.library_files f on f.id = sf.file_id
  join public.library_folders d on d.id = f.folder_id
  where sf.share_id = private.live_share_id(p_token)
    and sf.file_id = p_file_id
    and f.archived_at is null and d.archived_at is null
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.log_call(uuid),
  public.set_call_outcome(uuid, text, text),
  public.create_lead_share(uuid, uuid[], text),
  public.revoke_lead_share(uuid),
  public.open_lead_share(text, boolean),
  public.resolve_share_file(text, uuid),
  private.live_share_id(text),
  private.library_folders_before_write(),
  private.library_files_before_write()
from public, anon;

grant execute on function
  public.log_call(uuid),
  public.set_call_outcome(uuid, text, text),
  public.create_lead_share(uuid, uuid[], text),
  public.revoke_lead_share(uuid)
to authenticated;

grant execute on function
  public.open_lead_share(text, boolean),
  public.resolve_share_file(text, uuid)
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.library_folders, public.library_files, public.lead_shares;
  end if;
end $$;
