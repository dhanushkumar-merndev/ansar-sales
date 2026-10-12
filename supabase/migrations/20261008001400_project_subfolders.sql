-- ---------------------------------------------------------------------------
-- Folders inside folders. The insert policy of project_folders looked up the parent folder in
-- project_folders itself, which Postgres refuses ("infinite recursion detected in policy"), so no
-- sub-folder could be created. The parent check now runs in a definer helper outside RLS: the parent
-- must be a live folder of the same project, not money-only (payment proofs stay flat), and one the
-- user can read.
-- ---------------------------------------------------------------------------

create function private.can_nest_project_folder(p_parent_id uuid, p_project_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.project_folders p
    where p.id = p_parent_id and p.project_id = p_project_id and p.archived_at is null and not p.restricted
  ) and private.can_read_project_folder(p_parent_id)
$$;

revoke all on function private.can_nest_project_folder(uuid, uuid) from public, anon;
grant execute on function private.can_nest_project_folder(uuid, uuid) to authenticated, service_role;

drop policy project_folders_insert on public.project_folders;
create policy project_folders_insert on public.project_folders for insert to authenticated
  with check (not restricted and (select private.can_work_on_project(project_id))
    and (parent_id is null or private.can_nest_project_folder(parent_id, project_id)));
