-- Library: subfolders and preview thumbnails.
--
-- Subfolders: library_folders.parent_id. Invariant kept by the trigger: an active
-- folder's parent is active (a folder with active subfolders cannot be archived; a
-- subfolder cannot be restored under an archived parent). Every existing check
-- that looks at a file's own folder therefore stays correct.
--
-- Thumbnails: a small WEBP made in the browser at upload time, stored at
-- "<folder_id>/thumbs/<uuid>.webp" and linked through library_files.thumb_path.

-- ---------------------------------------------------------------------------
-- Subfolders
-- ---------------------------------------------------------------------------
alter table public.library_folders add column parent_id uuid references public.library_folders (id);

drop index public.library_folders_active_name_key;
create unique index library_folders_active_name_key on public.library_folders
  (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name) where archived_at is null;
create index library_folders_parent_idx on public.library_folders (parent_id, normalized_name, id);

create or replace function private.library_folders_before_write()
returns trigger
language plpgsql
as $$
declare
  v_depth integer;
begin
  new.name := private.clean_label(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
    new.archived_at := null;
    new.archived_by := null;
    if new.parent_id is not null then
      if not exists (select 1 from public.library_folders p where p.id = new.parent_id and p.archived_at is null) then
        raise exception 'folder_not_found' using errcode = 'P0002';
      end if;
      with recursive up as (
        select p.id, p.parent_id, 1 as depth from public.library_folders p where p.id = new.parent_id
        union all
        select p.id, p.parent_id, up.depth + 1 from public.library_folders p join up on p.id = up.parent_id where up.depth < 20
      )
      select max(depth) into v_depth from up;
      if v_depth >= 5 then
        raise exception 'folder_too_deep' using errcode = '22023';
      end if;
    end if;
  else
    new.parent_id := old.parent_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := (select auth.uid());
    if new.archived_at is distinct from old.archived_at then
      if new.archived_at is not null and exists (
        select 1 from public.library_folders c where c.parent_id = old.id and c.archived_at is null
      ) then
        raise exception 'folder_has_subfolders' using errcode = '22023';
      end if;
      if new.archived_at is null and old.parent_id is not null and not exists (
        select 1 from public.library_folders p where p.id = old.parent_id and p.archived_at is null
      ) then
        raise exception 'parent_folder_archived' using errcode = '22023';
      end if;
      new.archived_by := case when new.archived_at is null then null else (select auth.uid()) end;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

grant insert (name, parent_id) on public.library_folders to authenticated;

-- Root → folder breadcrumb, e.g. [{id, name: "Brochures"}, {id, name: "2026"}]. RLS applies.
create function public.library_folder_path(p_folder_id uuid)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with recursive up as (
    select f.id, f.name, f.parent_id, 0 as depth from public.library_folders f where f.id = p_folder_id
    union all
    select f.id, f.name, f.parent_id, up.depth + 1 from public.library_folders f join up on f.id = up.parent_id where up.depth < 20
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', up.id, 'name', up.name) order by up.depth desc), '[]'::jsonb) from up
$$;

-- Active folders with their full path ("Brochures / 2026"), for pickers. Bounded.
create function public.library_folder_options()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with recursive tree as (
    select f.id, f.name::text as path, 0 as depth from public.library_folders f
    where f.parent_id is null and f.archived_at is null
    union all
    select f.id, tree.path || ' / ' || f.name, tree.depth + 1 from public.library_folders f
    join tree on f.parent_id = tree.id
    where f.archived_at is null and tree.depth < 20
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'path', t.path) order by lower(t.path)), '[]'::jsonb)
  from (select * from tree order by lower(path) limit 300) t
$$;

-- ---------------------------------------------------------------------------
-- Thumbnails
-- ---------------------------------------------------------------------------
alter table public.library_files
  add column thumb_path text unique check (thumb_path is null or char_length(thumb_path) <= 300);

-- Links an uploaded thumbnail to its file once. Any lead user may set it (the
-- uploader right after upload, or anyone viewing older files without one).
create function public.set_library_thumbnail(p_file_id uuid, p_path text)
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
  select o.metadata ->> 'mimetype' into v_mime from storage.objects o where o.bucket_id = 'library' and o.name = p_path;
  if not found then
    raise exception 'file_not_uploaded' using errcode = 'P0002';
  end if;
  if v_mime is distinct from 'image/webp' then
    raise exception 'invalid_file_type' using errcode = '22023';
  end if;
  update public.library_files set thumb_path = p_path where id = v_file.id;
end $$;

-- The public share page also gets the thumbnail location.
create or replace function public.resolve_share_file(p_token text, p_file_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('storage_path', f.storage_path, 'thumb_path', f.thumb_path, 'name', f.name, 'mime_type', f.mime_type)
  from public.lead_share_files sf
  join public.library_files f on f.id = sf.file_id
  join public.library_folders d on d.id = f.folder_id
  where sf.share_id = private.live_share_id(p_token)
    and sf.file_id = p_file_id
    and f.archived_at is null and d.archived_at is null
$$;

create or replace function public.open_lead_share(p_token text, p_count_view boolean default true)
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
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'name', f.name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes,
        'has_preview', f.thumb_path is not null or f.mime_type like 'image/%'
      ) order by sf.position)
      from public.lead_share_files sf
      join public.library_files f on f.id = sf.file_id
      join public.library_folders d on d.id = f.folder_id
      where sf.share_id = v_share.id and f.archived_at is null and d.archived_at is null
    ), '[]'::jsonb)
  );
end $$;

-- A thumbnail belongs to its file: not a leftover upload, deletable with an archived file.
drop policy library_objects_delete on storage.objects;
create policy library_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'library'
    and (select private.is_admin())
    and (
      exists (
        select 1 from public.library_files f
        where (f.storage_path = objects.name or f.thumb_path = objects.name) and f.archived_at is not null
      )
      or (
        not exists (select 1 from public.library_files f where f.storage_path = objects.name or f.thumb_path = objects.name)
        and objects.created_at < now() - interval '1 hour'
      )
    )
  );

create or replace function public.admin_usage()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;

  with objs as (
    select o.bucket_id, o.name, coalesce((o.metadata ->> 'size')::bigint, 0) as bytes
    from storage.objects o
  ),
  lib as (
    select o.bytes, f.id as file_id, f.archived_at
    from objs o
    left join public.library_files f on f.storage_path = o.name or f.thumb_path = o.name
    where o.bucket_id = 'library'
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
        select d.name, sum(f.size_bytes) as bytes, count(*) as files
        from public.library_files f
        join public.library_folders d on d.id = f.folder_id
        where f.archived_at is null
        group by d.id, d.name
        order by bytes desc, d.name
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

create or replace function public.admin_unregistered_uploads(p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('path', t.name, 'bytes', t.bytes) order by t.created_at), '[]'::jsonb)
  into v_result
  from (
    select o.name, o.created_at, coalesce((o.metadata ->> 'size')::bigint, 0) as bytes
    from storage.objects o
    where o.bucket_id = 'library'
      and o.created_at < now() - interval '1 hour'
      and not exists (select 1 from public.library_files f where f.storage_path = o.name or f.thumb_path = o.name)
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 100)
  ) t;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.library_folder_path(uuid),
  public.library_folder_options(),
  public.set_library_thumbnail(uuid, text)
from public, anon;

grant execute on function
  public.library_folder_path(uuid),
  public.library_folder_options(),
  public.set_library_thumbnail(uuid, text)
to authenticated;
