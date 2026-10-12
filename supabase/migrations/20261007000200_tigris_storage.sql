-- Files move from Supabase Storage to one private Tigris (S3) bucket.
--
-- Tigris can't see Postgres RLS, so the Next.js server authorizes every upload/read with the
-- user's own RLS client and hands out short-lived presigned URLs. The database still refuses
-- to register a file that wasn't really uploaded: instead of storage.objects it now reads
-- private.storage_objects, a ledger written only by the server (service role) after it has
-- checked the object in Tigris (HEAD), so size and type still come from the store, not the client.
--
-- Object keys in Tigris are "<bucket>/<name>": library/<folder>/<file>.pdf, logos/<company>/<file>.png.
-- The paths stored on library_files / companies are unchanged.

create table private.storage_objects (
  bucket text not null check (bucket in ('library', 'logos')),
  name text not null check (char_length(name) <= 300),
  -- null until the server confirmed the upload (pending = a URL was handed out).
  size_bytes bigint check (size_bytes >= 0),
  mime_type text check (char_length(mime_type) <= 100),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (bucket, name)
);
create index storage_objects_created_idx on private.storage_objects (bucket, created_at);
alter table private.storage_objects enable row level security;
revoke all on private.storage_objects from public, anon, authenticated;

-- Existing Supabase Storage objects are copied to Tigris under the same names
-- (scripts/migrate-storage-to-tigris.mjs), so they are recorded as confirmed now.
insert into private.storage_objects (bucket, name, size_bytes, mime_type, confirmed_at, created_at)
select case o.bucket_id when 'library' then 'library' else 'logos' end,
  o.name, coalesce((o.metadata ->> 'size')::bigint, 0), coalesce(o.metadata ->> 'mimetype', ''), now(), o.created_at
from storage.objects o
where o.bucket_id in ('library', 'company-logos')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Ledger writes: service role only (the server, after it authorized the user and checked Tigris)
-- ---------------------------------------------------------------------------

-- p_size null = pending (an upload URL was issued); otherwise the object was seen in Tigris.
create function public.storage_record_object(p_bucket text, p_name text, p_size bigint default null, p_mime text default null)
returns void
language sql security definer set search_path = ''
as $$
  insert into private.storage_objects as o (bucket, name, size_bytes, mime_type, confirmed_at)
  values (p_bucket, p_name, p_size, p_mime, case when p_size is null then null else now() end)
  on conflict (bucket, name) do update
    set size_bytes = coalesce(excluded.size_bytes, o.size_bytes),
        mime_type = coalesce(excluded.mime_type, o.mime_type),
        confirmed_at = coalesce(excluded.confirmed_at, o.confirmed_at)
$$;

create function public.storage_forget_objects(p_bucket text, p_names text[])
returns void
language sql security definer set search_path = ''
as $$
  delete from private.storage_objects where bucket = p_bucket and name = any (p_names)
$$;

revoke all on function public.storage_record_object(text, text, bigint, text), public.storage_forget_objects(text, text[])
  from public, anon, authenticated;
grant execute on function public.storage_record_object(text, text, bigint, text), public.storage_forget_objects(text, text[])
  to service_role;

-- ---------------------------------------------------------------------------
-- Registration checks read the ledger instead of storage.objects
-- ---------------------------------------------------------------------------
create or replace function private.library_files_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_obj private.storage_objects%rowtype;
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
    select * into v_obj from private.storage_objects o
    where o.bucket = 'library' and o.name = new.storage_path and o.confirmed_at is not null;
    if not found then
      raise exception 'file_not_uploaded' using errcode = 'P0002';
    end if;
    new.size_bytes := coalesce(v_obj.size_bytes, 0);
    new.mime_type := coalesce(v_obj.mime_type, '');
    if new.mime_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp') then
      raise exception 'invalid_file_type' using errcode = '22023';
    end if;
  else
    if coalesce(current_setting('app.library_move', true), '') <> 'on' then
      new.folder_id := old.folder_id;
    end if;
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

create or replace function public.set_library_thumbnail(p_file_id uuid, p_path text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_file public.library_files%rowtype;
  v_mime text;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select * into v_file from public.library_files f where f.id = p_file_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_file.thumb_path is not null then
    raise exception 'thumbnail_exists' using errcode = '22023';
  end if;
  if p_path is null or p_path !~ ('^' || v_file.folder_id::text || '/thumbs/[0-9a-f-]{36}\.webp$') then
    raise exception 'invalid_file' using errcode = '22023';
  end if;
  select o.mime_type into v_mime from private.storage_objects o
  where o.bucket = 'library' and o.name = p_path and o.confirmed_at is not null;
  if not found then
    raise exception 'file_not_uploaded' using errcode = 'P0002';
  end if;
  if v_mime is distinct from 'image/webp' then
    raise exception 'invalid_file_type' using errcode = '22023';
  end if;
  update public.library_files set thumb_path = p_path where id = v_file.id;
end $$;

-- ---------------------------------------------------------------------------
-- Usage and cleanup read the ledger (super admin only, as before)
-- ---------------------------------------------------------------------------
create or replace function public.admin_usage()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;

  with objs as (
    select o.bucket, o.name, coalesce(o.size_bytes, 0) as bytes
    from private.storage_objects o
  ),
  lib as (
    select o.bytes, f.id as file_id, f.archived_at
    from objs o
    left join public.library_files f on f.storage_path = o.name or f.thumb_path = o.name
    where o.bucket = 'library'
  )
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'storage_bytes', (select coalesce(sum(bytes), 0) from objs),
    'storage_objects', (select count(*) from objs),
    'library', (
      select jsonb_build_object(
        'active_files', count(distinct file_id) filter (where file_id is not null and archived_at is null),
        'active_bytes', coalesce(sum(bytes) filter (where file_id is not null and archived_at is null), 0),
        'archived_files', count(distinct file_id) filter (where archived_at is not null),
        'archived_bytes', coalesce(sum(bytes) filter (where archived_at is not null), 0),
        'unregistered_files', count(*) filter (where file_id is null),
        'unregistered_bytes', coalesce(sum(bytes) filter (where file_id is null), 0)
      )
      from lib
    ),
    'by_folder', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'bytes', t.bytes, 'files', t.files) order by t.bytes desc, t.name), '[]'::jsonb)
      from (
        select c.name || ' · ' || d.name as name, sum(f.size_bytes) as bytes, count(*) as files
        from public.library_files f
        join public.library_folders d on d.id = f.folder_id
        join public.companies c on c.id = d.company_id
        where f.archived_at is null
        group by d.id, d.name, c.name
        order by bytes desc, name
        limit 8
      ) t
    ),
    'by_type', (
      select jsonb_build_object(
        'pdf_bytes', coalesce(sum(f.size_bytes) filter (where f.mime_type = 'application/pdf'), 0),
        'image_bytes', coalesce(sum(f.size_bytes) filter (where f.mime_type like 'image/%'), 0)
      )
      from public.library_files f
    ),
    'shares', (
      select jsonb_build_object(
        'active_links', count(*) filter (where s.revoked_at is null and (s.expires_at is null or s.expires_at > now())),
        'total_opens', coalesce(sum(s.view_count), 0)
      )
      from public.lead_shares s
    )
  ) into v_result;
  return v_result;
end $$;

-- Library uploads older than an hour that no file references: abandoned uploads (URL issued,
-- maybe never finished) and objects whose registration failed.
create or replace function public.admin_unregistered_uploads(p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('path', t.name, 'bytes', t.bytes) order by t.created_at), '[]'::jsonb)
  into v_result
  from (
    select o.name, o.created_at, coalesce(o.size_bytes, 0) as bytes
    from private.storage_objects o
    where o.bucket = 'library'
      and o.created_at < now() - interval '1 hour'
      and not exists (select 1 from public.library_files f where f.storage_path = o.name or f.thumb_path = o.name)
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 100)
  ) t;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Supabase Storage is no longer written by the app. The old buckets stay untouched as a
-- rollback copy until they are removed by hand; nobody can upload to or delete from them now.
-- ---------------------------------------------------------------------------
drop policy if exists library_objects_select on storage.objects;
drop policy if exists library_objects_insert on storage.objects;
drop policy if exists library_objects_delete on storage.objects;
drop policy if exists company_logos_insert on storage.objects;
drop policy if exists company_logos_delete on storage.objects;
