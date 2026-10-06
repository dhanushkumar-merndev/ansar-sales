-- Library sorting and a shared custom order.
--
-- position: an admin-arranged order shared by a folder's subfolders and files (one
-- number space per parent, so folders and files can be interleaved). New items go
-- to the end. Existing rows start as "folders by name, then files newest first",
-- which is how the library was shown until now.
--
-- list_library_items: one paginated list of a folder's subfolders and files (top
-- level: folders only), sorted by custom order, name or created date, with folders
-- either first or mixed in. Runs as the caller, so RLS scopes it.
--
-- reorder_library_items: Admin rearranges a set of siblings (one visible page). The
-- set keeps the positions it already had, handed out in the new order, so items on
-- other pages don't move.

alter table public.library_folders add column position bigint not null default 0;
alter table public.library_files add column position bigint not null default 0;

alter table public.library_folders disable trigger user;
alter table public.library_files disable trigger user;

with r as (
  select id, row_number() over (partition by company_id, parent_id order by normalized_name, id) as n
  from public.library_folders
)
update public.library_folders d set position = r.n from r where r.id = d.id;

with r as (
  select f.id,
    row_number() over (partition by f.folder_id order by f.created_at desc, f.id desc)
      + (select count(*) from public.library_folders c where c.parent_id = f.folder_id) as n
  from public.library_files f
)
update public.library_files f set position = r.n from r where r.id = f.id;

alter table public.library_folders enable trigger user;
alter table public.library_files enable trigger user;

create index library_folders_position_idx on public.library_folders (parent_id, position, id);
create index library_files_position_idx on public.library_files (folder_id, position, id);

-- Runs as the caller: RLS limits the siblings it sees to the caller's company.
create function private.library_position_before_insert()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v_parent uuid := (to_jsonb(new) ->> case tg_table_name when 'library_files' then 'folder_id' else 'parent_id' end)::uuid;
begin
  new.position := 1 + greatest(
    coalesce((select max(d.position) from public.library_folders d where d.parent_id is not distinct from v_parent), 0),
    coalesce((select max(f.position) from public.library_files f where v_parent is not null and f.folder_id = v_parent), 0)
  );
  return new;
end $$;

create trigger library_position before insert on public.library_folders
  for each row execute function private.library_position_before_insert();
create trigger library_position before insert on public.library_files
  for each row execute function private.library_position_before_insert();

grant update (position) on public.library_folders, public.library_files to authenticated;

create function public.list_library_items(
  p_parent_id uuid default null,
  p_search text default null,
  p_archived boolean default false,
  p_sort text default 'custom',
  p_dir text default 'asc',
  p_folders_first boolean default true,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable set search_path = ''
as $$
declare
  v_term text := nullif(lower(btrim(p_search)), '');
  v_pattern text;
  v_archived boolean := coalesce(p_archived, false);
  v_first boolean := coalesce(p_folders_first, true);
  v_total bigint;
  v_items jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_offset' using errcode = '22023';
  end if;
  if p_sort is null or p_sort not in ('custom', 'name', 'created') or p_dir is null or p_dir not in ('asc', 'desc') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with entries as (
    select 'folder'::text as kind, d.id, d.normalized_name as sort_name, d.created_at, d.position
    from public.library_folders d
    where ((p_parent_id is null and d.parent_id is null) or d.parent_id = p_parent_id)
      and (d.archived_at is not null) = v_archived
      and (v_pattern is null or d.normalized_name like v_pattern)
    union all
    select 'file', f.id, f.normalized_name, f.created_at, f.position
    from public.library_files f
    where p_parent_id is not null and f.folder_id = p_parent_id
      and (f.archived_at is not null) = v_archived
      and (v_pattern is null or f.normalized_name like v_pattern)
  ),
  ranked as (
    select e.kind, e.id, count(*) over () as total,
      row_number() over (order by
        case when v_first and e.kind = 'file' then 1 else 0 end,
        case when p_sort = 'name' and p_dir = 'asc' then e.sort_name end asc,
        case when p_sort = 'name' and p_dir = 'desc' then e.sort_name end desc,
        case when p_sort = 'created' and p_dir = 'asc' then e.created_at end asc,
        case when p_sort = 'created' and p_dir = 'desc' then e.created_at end desc,
        case when p_sort = 'custom' and p_dir = 'asc' then e.position end asc,
        case when p_sort = 'custom' and p_dir = 'desc' then e.position end desc,
        e.kind, e.id) as rn
    from entries e
  ),
  page as (
    select * from ranked where rn > p_offset and rn <= p_offset + p_limit
  )
  select
    coalesce((select max(total) from ranked), 0),
    coalesce(jsonb_agg(
      case p.kind
        when 'folder' then jsonb_build_object(
          'kind', 'folder', 'id', d.id, 'name', d.name, 'parent_id', d.parent_id,
          'created_at', d.created_at, 'archived_at', d.archived_at, 'position', d.position,
          'file_count', (select count(*) from public.library_files x where x.folder_id = d.id and x.archived_at is null),
          'subfolder_count', (select count(*) from public.library_folders c where c.parent_id = d.id and c.archived_at is null))
        else jsonb_build_object(
          'kind', 'file', 'id', f.id, 'name', f.name, 'folder_id', f.folder_id,
          'storage_path', f.storage_path, 'thumb_path', f.thumb_path, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes,
          'created_at', f.created_at, 'archived_at', f.archived_at, 'position', f.position)
      end order by p.rn), '[]'::jsonb)
  into v_total, v_items
  from page p
  left join public.library_folders d on p.kind = 'folder' and d.id = p.id
  left join public.library_files f on p.kind = 'file' and f.id = p.id;

  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.reorder_library_items(p_parent_id uuid, p_items jsonb)
returns void
language plpgsql set search_path = ''
as $$
declare
  v_n integer;
  v_found integer;
  v_distinct integer;
  v_map jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'invalid_order' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_items);
  if v_n < 1 or v_n > 100 then
    raise exception 'invalid_order' using errcode = '22023';
  end if;

  -- Lock the siblings being rearranged (RLS keeps this to the caller's company).
  perform 1 from public.library_folders d
  where d.id in (select (e ->> 'id')::uuid from jsonb_array_elements(p_items) e where e ->> 'kind' = 'folder')
  order by d.id for update;
  perform 1 from public.library_files f
  where f.id in (select (e ->> 'id')::uuid from jsonb_array_elements(p_items) e where e ->> 'kind' = 'file')
  order by f.id for update;

  with wanted as (
    select e ->> 'kind' as kind, (e ->> 'id')::uuid as id, t.ord
    from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  ),
  cur as (
    select w.kind, w.id, w.ord, coalesce(d.position, f.position) as position,
      (d.id is not null or f.id is not null) as matched
    from wanted w
    left join public.library_folders d on w.kind = 'folder' and d.id = w.id
      and ((p_parent_id is null and d.parent_id is null) or d.parent_id = p_parent_id)
    left join public.library_files f on w.kind = 'file' and f.id = w.id
      and p_parent_id is not null and f.folder_id = p_parent_id
  ),
  slots as (
    select position, row_number() over (order by position, kind, id) as slot from cur where matched
  )
  select
    (select count(*) from cur where matched),
    (select count(distinct (kind, id)) from cur),
    (select jsonb_agg(jsonb_build_object('kind', c.kind, 'id', c.id, 'position', s.position))
       from cur c join slots s on s.slot = c.ord)
  into v_found, v_distinct, v_map;

  if v_found <> v_n or v_distinct <> v_n then
    raise exception 'invalid_order' using errcode = '22023';
  end if;

  update public.library_folders d set position = m.position
  from jsonb_to_recordset(v_map) as m(kind text, id uuid, position bigint)
  where m.kind = 'folder' and d.id = m.id and d.position <> m.position;

  update public.library_files f set position = m.position
  from jsonb_to_recordset(v_map) as m(kind text, id uuid, position bigint)
  where m.kind = 'file' and f.id = m.id and f.position <> m.position;
end $$;

revoke all on function
  private.library_position_before_insert(),
  public.list_library_items(uuid, text, boolean, text, text, boolean, integer, integer),
  public.reorder_library_items(uuid, jsonb)
from public, anon;

grant execute on function
  public.list_library_items(uuid, text, boolean, text, text, boolean, integer, integer),
  public.reorder_library_items(uuid, jsonb)
to authenticated;
