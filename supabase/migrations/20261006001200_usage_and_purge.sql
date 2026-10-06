-- Admin usage overview (storage, database, library) and freeing space by permanently
-- deleting archived library files and leftover uploads.
--
-- Storage objects are removed through the Storage API with the admin's own session
-- (Supabase blocks direct SQL deletes from storage.objects), so the delete policy
-- below is what limits it: only archived files' objects, or uploads that were never
-- registered and are older than an hour. Active files can never be deleted.

create policy library_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'library'
    and (select private.is_admin())
    and (
      exists (select 1 from public.library_files f where f.storage_path = objects.name and f.archived_at is not null)
      or (
        not exists (select 1 from public.library_files f where f.storage_path = objects.name)
        and objects.created_at < now() - interval '1 hour'
      )
    )
  );

create function public.admin_usage()
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
    left join public.library_files f on f.storage_path = o.name
    where o.bucket_id = 'library'
  )
  select jsonb_build_object(
    'database_bytes', pg_database_size(current_database()),
    'storage_bytes', (select coalesce(sum(bytes), 0) from objs),
    'storage_objects', (select count(*) from objs),
    'library', (
      select jsonb_build_object(
        'active_files', count(*) filter (where file_id is not null and archived_at is null),
        'active_bytes', coalesce(sum(bytes) filter (where file_id is not null and archived_at is null), 0),
        'archived_files', count(*) filter (where archived_at is not null),
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

-- Removes an archived file's records after its Storage object was deleted.
-- Share links that included it keep working with their remaining files; the
-- timeline keeps the file name (stored in the files_shared event).
create function public.admin_purge_library_file(p_file_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_file public.library_files%rowtype;
  v_folder text;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_file from public.library_files f where f.id = p_file_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_file.archived_at is null then
    raise exception 'file_not_archived' using errcode = '22023';
  end if;
  select d.name into v_folder from public.library_folders d where d.id = v_file.folder_id;

  delete from public.lead_share_files sf where sf.file_id = v_file.id;
  delete from public.library_files f where f.id = v_file.id;

  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'library_file_deleted', jsonb_build_object(
    'file_id', v_file.id, 'name', v_file.name, 'folder', v_folder,
    'size_bytes', v_file.size_bytes, 'storage_path', v_file.storage_path));
end $$;

-- Uploads that never got a library_files row (e.g. the browser closed mid-way),
-- older than an hour so an upload in progress is never listed. Bounded.
create function public.admin_unregistered_uploads(p_limit integer default 100)
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
      and not exists (select 1 from public.library_files f where f.storage_path = o.name)
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 100), 1), 100)
  ) t;
  return v_result;
end $$;

revoke all on function
  public.admin_usage(),
  public.admin_purge_library_file(uuid),
  public.admin_unregistered_uploads(integer)
from public, anon;

grant execute on function
  public.admin_usage(),
  public.admin_purge_library_file(uuid),
  public.admin_unregistered_uploads(integer)
to authenticated;
