-- ---------------------------------------------------------------------------
-- Project folders: archive, restore, delete for good.
--   * Whoever made a folder (while still on the team), the project's architect manager and admins can
--     archive it. Its sub-folders go with it (same archived_at, so a restore brings back exactly that
--     set) and its files disappear with it; nothing is deleted, and the files still count towards the
--     project's storage.
--   * Admins and the architect manager see the archived folders, and restore them or delete them for
--     good. Deleting runs in two steps from the server: purge_project_folder_paths lists the Tigris
--     objects (and checks the caller), the server removes them, then purge_project_folder deletes the
--     rows. Retrying after a half-done delete is safe.
--   * The standard folders (system_key) are never archived.
-- ---------------------------------------------------------------------------

alter table public.project_folders add column archived_by uuid references public.profiles (id);

-- The folder and every folder under it (any state), at most 20 levels down.
create function private.project_folder_subtree(p_folder_id uuid)
returns table (id uuid)
language sql stable security definer set search_path = ''
as $$
  with recursive t as (
    select f.id, 0 as depth from public.project_folders f where f.id = p_folder_id
    union all
    select c.id, t.depth + 1 from public.project_folders c join t on c.parent_id = t.id where t.depth < 20
  )
  select t.id from t
$$;

create function public.archive_project_folder(p_folder_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  f public.project_folders;
  v_now timestamptz := now();
  v_ids uuid[];
begin
  select * into f from public.project_folders where id = p_folder_id and archived_at is null for update;
  if f.id is null or not private.can_read_project_folder(f.id) then
    perform private.raise_forbidden();
  end if;
  if f.system_key is not null then
    raise exception 'standard_folder' using errcode = '22023';
  end if;
  if not (private.can_manage_project(f.project_id)
          or (f.created_by = (select auth.uid()) and private.can_work_on_project(f.project_id))) then
    perform private.raise_forbidden();
  end if;

  select array_agg(s.id) into v_ids
  from private.project_folder_subtree(f.id) s join public.project_folders x on x.id = s.id
  where x.archived_at is null;
  update public.project_folders set archived_at = v_now, archived_by = (select auth.uid()) where id = any (v_ids);

  return jsonb_build_object(
    'folders', coalesce(array_length(v_ids, 1), 0),
    'files', (select count(*) from public.project_files pf where pf.folder_id = any (v_ids) and pf.archived_at is null));
end $$;

-- An archived folder whose parent is still there (or that sits at the top): what the Archived list shows.
create function public.archived_project_folders(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_money boolean;
begin
  if not private.can_manage_project(p_project_id) then
    perform private.raise_forbidden();
  end if;
  v_money := private.can_see_project_money(p_project_id);
  return coalesce((
    select jsonb_agg(row_to_json(r)::jsonb order by r.archived_at desc, r.id)
    from (
      select f.id, f.name, f.archived_at,
        (select p.name from public.project_folders p where p.id = f.parent_id) as parent_name,
        (f.parent_id is not null and par.archived_at is not null) as parent_archived,
        (select pr.display_name from public.profiles pr where pr.id = f.archived_by) as archived_by,
        (select pr.display_name from public.profiles pr where pr.id = f.created_by) as created_by,
        -- Everything a delete would remove (also sub-folders archived on their own earlier).
        (select count(*) - 1 from private.project_folder_subtree(f.id) s) as folders,
        (select count(*) from public.project_files pf where pf.folder_id in (select s.id from private.project_folder_subtree(f.id) s)
           and pf.archived_at is null) as files,
        (select coalesce(sum(v.size_bytes), 0) from public.project_file_versions v join public.project_files pf on pf.id = v.file_id
           where pf.folder_id in (select s.id from private.project_folder_subtree(f.id) s)) as bytes
      from public.project_folders f
      left join public.project_folders par on par.id = f.parent_id
      where f.project_id = p_project_id and f.archived_at is not null and f.system_key is null
        and (v_money or not f.restricted)
        and (par.id is null or par.archived_at is distinct from f.archived_at)
      limit 200
    ) r), '[]'::jsonb);
end $$;

create function private.check_archived_project_folder(p_folder_id uuid)
returns public.project_folders
language plpgsql stable security definer set search_path = ''
as $$
declare
  f public.project_folders;
begin
  select * into f from public.project_folders where id = p_folder_id;
  if f.id is null or not private.can_manage_project(f.project_id) or (f.restricted and not private.can_see_project_money(f.project_id)) then
    perform private.raise_forbidden();
  end if;
  if f.archived_at is null then
    raise exception 'folder_not_archived' using errcode = '22023';
  end if;
  return f;
end $$;

-- Restores the folder and the sub-folders archived with it. Its parent must be there; a folder of the
-- same name made since then blocks it (23505), so the caller renames that one first.
create function public.restore_project_folder(p_folder_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.project_folders := private.check_archived_project_folder(p_folder_id);
begin
  if f.parent_id is not null and exists (select 1 from public.project_folders p where p.id = f.parent_id and p.archived_at is not null) then
    raise exception 'parent_archived' using errcode = '22023';
  end if;
  update public.project_folders x set archived_at = null, archived_by = null
  where x.id in (select s.id from private.project_folder_subtree(f.id) s) and x.archived_at = f.archived_at;
end $$;

-- Every stored object under the archived folder (all versions, also of files archived on their own).
create function public.purge_project_folder_paths(p_folder_id uuid)
returns text[]
language plpgsql stable security definer set search_path = ''
as $$
declare
  f public.project_folders := private.check_archived_project_folder(p_folder_id);
begin
  return coalesce((
    select array_agg(v.storage_path) from public.project_file_versions v join public.project_files pf on pf.id = v.file_id
    where pf.folder_id in (select s.id from private.project_folder_subtree(f.id) s)), '{}');
end $$;

-- Deletes the archived folder, everything under it and its files' versions, notes and history.
create function public.purge_project_folder(p_folder_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  f public.project_folders := private.check_archived_project_folder(p_folder_id);
  v_ids uuid[];
  v_files integer;
begin
  select array_agg(s.id) into v_ids from private.project_folder_subtree(f.id) s;
  delete from public.project_files where folder_id = any (v_ids);
  get diagnostics v_files = row_count;
  delete from public.project_folders where id = any (v_ids);
  return jsonb_build_object('folders', coalesce(array_length(v_ids, 1), 0), 'files', v_files);
end $$;

revoke all on function private.project_folder_subtree(uuid) from public, anon, authenticated;
revoke all on function private.check_archived_project_folder(uuid) from public, anon, authenticated;
revoke all on function public.archive_project_folder(uuid), public.archived_project_folders(uuid), public.restore_project_folder(uuid),
  public.purge_project_folder_paths(uuid), public.purge_project_folder(uuid) from public, anon;
grant execute on function public.archive_project_folder(uuid), public.archived_project_folders(uuid), public.restore_project_folder(uuid),
  public.purge_project_folder_paths(uuid), public.purge_project_folder(uuid) to authenticated;
grant execute on function private.project_folder_subtree(uuid), private.check_archived_project_folder(uuid) to service_role;
