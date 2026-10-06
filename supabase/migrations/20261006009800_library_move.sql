-- Moving library folders and files to another folder (Admin).
--
-- Rows keep their storage paths: a file moved out of "<old folder>/…" still opens,
-- because Storage access only needs that folder row to exist in the company, and
-- folders are never deleted. Copies are made by the browser through the Storage API
-- (copy, then register the new object as usual), so they need nothing here.
--
-- parent_id / folder_id stay immutable for ordinary updates (no column grant, and
-- the triggers pin them); only move_library_items, after its checks, flips a
-- transaction-local flag that lets the triggers accept the new parent.

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
    if coalesce(current_setting('app.library_move', true), '') <> 'on' then
      new.parent_id := old.parent_id;
    end if;
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

create or replace function private.library_files_before_write()
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

-- p_target_folder_id null = top level (folders only). Items keep the order given and
-- go to the end of the target's custom order. Returns how many rows changed folder.
create function public.move_library_items(p_target_folder_id uuid, p_items jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_n integer;
  v_folder_ids uuid[];
  v_file_ids uuid[];
  v_target_depth integer := 0;
  v_cycle boolean := false;
  v_height integer := 0;
  v_pos bigint;
  v_moved integer := 0;
  v_count integer;
  r record;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'invalid_move' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 100 then
    raise exception 'invalid_move' using errcode = '22023';
  end if;

  select
    coalesce(array_agg(distinct (e ->> 'id')::uuid) filter (where e ->> 'kind' = 'folder'), '{}'),
    coalesce(array_agg(distinct (e ->> 'id')::uuid) filter (where e ->> 'kind' = 'file'), '{}')
  into v_folder_ids, v_file_ids
  from jsonb_array_elements(p_items) e;
  if cardinality(v_folder_ids) + cardinality(v_file_ids) <> v_n then
    raise exception 'invalid_move' using errcode = '22023';
  end if;

  if p_target_folder_id is null then
    if cardinality(v_file_ids) > 0 then
      raise exception 'invalid_move' using errcode = '22023';
    end if;
  elsif not exists (
    select 1 from public.library_folders t
    where t.id = p_target_folder_id and t.company_id = v_company and t.archived_at is null
  ) then
    raise exception 'folder_not_found' using errcode = 'P0002';
  end if;

  perform 1 from public.library_folders d where d.id = any(v_folder_ids) order by d.id for update;
  perform 1 from public.library_files f where f.id = any(v_file_ids) order by f.id for update;
  if (select count(*) from public.library_folders d
      where d.id = any(v_folder_ids) and d.company_id = v_company and d.archived_at is null) <> cardinality(v_folder_ids)
     or (select count(*) from public.library_files f
      where f.id = any(v_file_ids) and f.company_id = v_company and f.archived_at is null) <> cardinality(v_file_ids) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if cardinality(v_folder_ids) > 0 then
    -- A folder can't go into itself or anything below it, and nesting stays within 5 levels.
    if p_target_folder_id is not null then
      with recursive up as (
        select t.id, t.parent_id, 1 as depth from public.library_folders t where t.id = p_target_folder_id
        union all
        select p.id, p.parent_id, up.depth + 1 from public.library_folders p join up on p.id = up.parent_id where up.depth < 20
      )
      select max(depth), coalesce(bool_or(id = any(v_folder_ids)), false) into v_target_depth, v_cycle from up;
      if v_cycle then
        raise exception 'invalid_move' using errcode = '22023';
      end if;
    end if;
    with recursive down as (
      select d.id, 1 as h from public.library_folders d where d.id = any(v_folder_ids)
      union all
      select c.id, down.h + 1 from public.library_folders c join down on c.parent_id = down.id
      where c.archived_at is null and down.h < 20
    )
    select coalesce(max(h), 0) into v_height from down;
    if v_target_depth + v_height > 5 then
      raise exception 'folder_too_deep' using errcode = '22023';
    end if;
  end if;

  v_pos := greatest(
    coalesce((select max(d.position) from public.library_folders d
      where d.company_id = v_company and d.parent_id is not distinct from p_target_folder_id), 0),
    coalesce((select max(f.position) from public.library_files f
      where p_target_folder_id is not null and f.folder_id = p_target_folder_id), 0)
  );

  perform set_config('app.library_move', 'on', true);
  for r in
    select e ->> 'kind' as kind, (e ->> 'id')::uuid as id
    from jsonb_array_elements(p_items) with ordinality as t(e, ord) order by t.ord
  loop
    v_pos := v_pos + 1;
    if r.kind = 'folder' then
      update public.library_folders set parent_id = p_target_folder_id, position = v_pos
      where id = r.id and parent_id is distinct from p_target_folder_id;
    else
      update public.library_files set folder_id = p_target_folder_id, position = v_pos
      where id = r.id and folder_id <> p_target_folder_id;
    end if;
    get diagnostics v_count = row_count;
    v_moved := v_moved + v_count;
  end loop;
  perform set_config('app.library_move', '', true);
  return v_moved;
end $$;

revoke all on function public.move_library_items(uuid, jsonb) from public, anon;
grant execute on function public.move_library_items(uuid, jsonb) to authenticated;
