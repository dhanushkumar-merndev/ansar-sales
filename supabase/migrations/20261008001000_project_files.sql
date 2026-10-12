-- ---------------------------------------------------------------------------
-- Project files (projects module): a folder tree per project, files with versions,
-- an approval flow, client visibility and a file history ("sent to client" tracking).
--
-- Storage: Tigris bucket prefix "projects/", object names "<projectId>/<uuid>.<ext>".
-- The server authorizes (RLS), checks the per-project quota (100 GB by default),
-- presigns the upload (multipart for big files), confirms it with HEAD into the ledger,
-- then registers the version here; the database re-checks the ledger and the quota.
--
-- Version status:  draft → submitted → approved (visible to the client) →
--                  client_approved | changes_requested;  superseded when a newer one is approved.
-- The client never reads these tables; the portal uses definer RPCs that return approved
-- (or later) versions only. "Payment proofs" is restricted to admin and account.
-- ---------------------------------------------------------------------------

alter table private.storage_objects drop constraint storage_objects_bucket_check;
alter table private.storage_objects add constraint storage_objects_bucket_check check (bucket in ('library', 'logos', 'projects'));

create table public.project_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  parent_id uuid references public.project_folders (id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  system_key text check (system_key is null or system_key ~ '^[a-z_]{2,30}$'),
  restricted boolean not null default false,
  position integer not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index project_folders_name_key on public.project_folders (project_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name))) where archived_at is null;
create unique index project_folders_system_key on public.project_folders (project_id, system_key) where system_key is not null;
create index project_folders_project_idx on public.project_folders (project_id, parent_id, position) where archived_at is null;

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  folder_id uuid not null references public.project_folders (id),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  kind text not null check (kind in ('image', 'pdf', 'cad', 'sketchup', 'video', 'office', 'archive', 'other')),
  phase_id uuid references public.project_phases (id) on delete set null,
  payment_id uuid references public.project_payments (id) on delete set null,
  current_version_id uuid,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);
create index project_files_folder_idx on public.project_files (folder_id, updated_at desc) where archived_at is null;
create index project_files_project_idx on public.project_files (project_id) where archived_at is null;

create table public.project_file_versions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references public.project_files (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  version_no integer not null,
  storage_path text not null unique check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.[a-z0-9]{2,5}$'),
  original_name text not null check (char_length(original_name) between 1 and 255),
  size_bytes bigint not null check (size_bytes > 0),
  mime_type text not null check (char_length(mime_type) <= 100),
  note text check (note is null or char_length(note) <= 1000),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'client_approved', 'changes_requested', 'superseded')),
  status_by uuid references public.profiles (id),
  status_at timestamptz,
  client_comment text check (client_comment is null or char_length(client_comment) <= 2000),
  uploaded_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (file_id, version_no)
);
create index project_file_versions_project_idx on public.project_file_versions (project_id, status);
alter table public.project_files add constraint project_files_current_version_fkey
  foreign key (current_version_id) references public.project_file_versions (id) deferrable initially deferred;

create table public.project_file_comments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.project_file_versions (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  page integer check (page is null or page between 1 and 5000),
  x_pct numeric(6, 3) check (x_pct is null or x_pct between 0 and 100),
  y_pct numeric(6, 3) check (y_pct is null or y_pct between 0 and 100),
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  author_id uuid references public.profiles (id),
  from_client boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id)
);
create index project_file_comments_version_idx on public.project_file_comments (version_id, created_at);

-- File history: uploads, reviews, what went to the client and what the client did.
create table public.project_file_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  file_id uuid not null references public.project_files (id) on delete cascade,
  version_id uuid references public.project_file_versions (id) on delete cascade,
  type text not null check (type in ('uploaded', 'submitted', 'approved', 'changes_requested', 'client_viewed', 'client_downloaded',
    'client_approved', 'client_changes', 'superseded', 'archived', 'restored')),
  actor_id uuid references public.profiles (id),
  from_client boolean not null default false,
  comment text check (comment is null or char_length(comment) <= 2000),
  created_at timestamptz not null default now()
);
create index project_file_events_file_idx on public.project_file_events (file_id, created_at desc);
create index project_file_events_project_idx on public.project_file_events (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------
create function private.can_read_project_folder(p_folder_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.project_folders f where f.id = p_folder_id and f.archived_at is null and (
    case when f.restricted then private.can_see_project_money(f.project_id) else private.can_work_on_project(f.project_id) end))
$$;

-- Uploading needs the same as reading the folder (team for design folders, admin/account for proofs).
create function private.can_write_project_folder(p_folder_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select private.can_read_project_folder(p_folder_id) $$;

create function private.file_kind(p_ext text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when p_ext in ('jpg', 'jpeg', 'png', 'webp', 'heic', 'gif') then 'image'
    when p_ext = 'pdf' then 'pdf'
    when p_ext in ('dwg', 'dxf') then 'cad'
    when p_ext = 'skp' then 'sketchup'
    when p_ext in ('mp4', 'mov', 'webm') then 'video'
    when p_ext in ('xlsx', 'xls', 'docx', 'doc', 'pptx', 'csv') then 'office'
    when p_ext = 'zip' then 'archive'
    else 'other' end
$$;

-- Bytes used by a project's files (every version that isn't archived with its file).
create function public.project_storage_usage(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.can_work_on_project(p_project_id) or private.can_see_project_money(p_project_id)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'used', (select coalesce(sum(v.size_bytes), 0) from public.project_file_versions v join public.project_files f on f.id = v.file_id
      where v.project_id = p_project_id and f.archived_at is null),
    'quota', (select p.storage_quota_bytes from public.projects p where p.id = p_project_id),
    'files', (select count(*) from public.project_files f where f.project_id = p_project_id and f.archived_at is null));
end $$;

-- ---------------------------------------------------------------------------
-- Default folders for every project
-- ---------------------------------------------------------------------------
create function private.seed_project_folders()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.project_folders (project_id, name, system_key, restricted, position, created_by)
  values
    (new.id, 'Site images', 'site_images', false, 1, new.created_by),
    (new.id, 'Layout & deck', 'layout_deck', false, 2, new.created_by),
    (new.id, 'BOQ', 'boq', false, 3, new.created_by),
    (new.id, 'GFC drawings (DWG)', 'gfc', false, 4, new.created_by),
    (new.id, '3D / SketchUp', 'three_d', false, 5, new.created_by),
    (new.id, 'Execution photos', 'execution_photos', false, 6, new.created_by),
    (new.id, 'Handover', 'handover', false, 7, new.created_by),
    (new.id, 'Payment proofs', 'payment_proofs', true, 8, new.created_by);
  return null;
end $$;

create trigger projects_seed_folders after insert on public.projects
  for each row execute function private.seed_project_folders();

-- ---------------------------------------------------------------------------
-- Register an uploaded object as a new file or a new version of a file
-- ---------------------------------------------------------------------------
create function public.register_project_file(
  p_folder_id uuid, p_path text, p_name text, p_file_id uuid default null, p_note text default null,
  p_phase_id uuid default null, p_payment_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_folder public.project_folders%rowtype;
  v_obj record;
  v_file public.project_files%rowtype;
  v_version uuid;
  v_no integer;
  v_used bigint;
  v_quota bigint;
  v_ext text := lower(substring(p_path from '\.([a-z0-9]{2,5})$'));
begin
  select * into v_folder from public.project_folders where id = p_folder_id and archived_at is null;
  if not found or not private.can_write_project_folder(p_folder_id) then
    raise exception 'folder_not_found' using errcode = 'P0002';
  end if;
  if split_part(p_path, '/', 1) <> v_folder.project_id::text then
    raise exception 'invalid_file' using errcode = '22023';
  end if;
  select o.size_bytes, o.mime_type into v_obj from private.storage_objects o
  where o.bucket = 'projects' and o.name = p_path and o.confirmed_at is not null;
  if not found then
    raise exception 'file_not_uploaded' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.project_file_versions v where v.storage_path = p_path) then
    raise exception 'invalid_file' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('project_storage:' || v_folder.project_id::text, 0));
  select coalesce(sum(v.size_bytes), 0) into v_used from public.project_file_versions v join public.project_files f on f.id = v.file_id
  where v.project_id = v_folder.project_id and f.archived_at is null;
  select p.storage_quota_bytes into v_quota from public.projects p where p.id = v_folder.project_id;
  if v_used + v_obj.size_bytes > v_quota then
    raise exception 'storage_full' using errcode = '53100';
  end if;

  if p_file_id is null then
    insert into public.project_files (project_id, folder_id, name, kind, phase_id, payment_id, created_by)
    values (v_folder.project_id, p_folder_id, left(btrim(p_name), 200), private.file_kind(v_ext),
      (select ph.id from public.project_phases ph where ph.id = p_phase_id and ph.project_id = v_folder.project_id),
      (select pp.id from public.project_payments pp where pp.id = p_payment_id and pp.project_id = v_folder.project_id and v_folder.restricted),
      (select auth.uid()))
    returning * into v_file;
    v_no := 1;
  else
    select * into v_file from public.project_files where id = p_file_id and folder_id = p_folder_id and archived_at is null for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    select coalesce(max(v.version_no), 0) + 1 into v_no from public.project_file_versions v where v.file_id = v_file.id;
  end if;

  insert into public.project_file_versions (file_id, project_id, version_no, storage_path, original_name, size_bytes, mime_type, note, uploaded_by)
  values (v_file.id, v_file.project_id, v_no, p_path, left(btrim(p_name), 255), v_obj.size_bytes, v_obj.mime_type,
    nullif(btrim(coalesce(p_note, '')), ''), (select auth.uid()))
  returning id into v_version;
  update public.project_files set current_version_id = v_version, updated_at = now() where id = v_file.id;
  insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, comment)
  values (v_file.project_id, v_file.id, v_version, 'uploaded', (select auth.uid()), nullif(btrim(coalesce(p_note, '')), ''));
  return jsonb_build_object('file_id', v_file.id, 'version_id', v_version, 'version_no', v_no);
end $$;

-- Review flow. Team: submit. Architect manager / admin: approve (client can see it) or ask for changes.
create function public.set_file_version_status(p_version_id uuid, p_status text, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v public.project_file_versions%rowtype;
  v_folder public.project_folders%rowtype;
begin
  select * into v from public.project_file_versions where id = p_version_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select fo.* into v_folder from public.project_files f join public.project_folders fo on fo.id = f.folder_id where f.id = v.file_id;
  if not private.can_read_project_folder(v_folder.id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_status = 'submitted' then
    if v.status not in ('draft', 'changes_requested') then
      raise exception 'invalid_status' using errcode = '22023';
    end if;
  elsif p_status in ('approved', 'changes_requested') then
    if not private.can_manage_project(v.project_id) then
      perform private.raise_forbidden();
    end if;
    if v.status = 'superseded' then
      raise exception 'invalid_status' using errcode = '22023';
    end if;
  elsif p_status = 'draft' then
    if not private.can_manage_project(v.project_id) and v.uploaded_by is distinct from (select auth.uid()) then
      perform private.raise_forbidden();
    end if;
  else
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  update public.project_file_versions set status = p_status, status_by = (select auth.uid()), status_at = now()
  where id = p_version_id;
  if p_status = 'approved' then
    -- One version per file is current for the client.
    update public.project_file_versions set status = 'superseded', status_at = now()
    where file_id = v.file_id and id <> p_version_id and status in ('approved', 'client_approved', 'changes_requested', 'submitted', 'draft')
      and version_no < v.version_no;
    insert into public.project_file_events (project_id, file_id, version_id, type, actor_id)
    select v.project_id, v.file_id, x.id, 'superseded', (select auth.uid())
    from public.project_file_versions x where x.file_id = v.file_id and x.id <> p_version_id and x.status = 'superseded' and x.status_at = now();
  end if;
  insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, comment)
  values (v.project_id, v.file_id, p_version_id, case p_status when 'draft' then 'restored' else p_status end, (select auth.uid()),
    left(private.clean_label(p_comment), 2000));
end $$;

-- ---------------------------------------------------------------------------
-- RLS (team / money only; writes through RPCs, except comments and folder/file housekeeping)
-- ---------------------------------------------------------------------------
alter table public.project_folders enable row level security;
alter table public.project_files enable row level security;
alter table public.project_file_versions enable row level security;
alter table public.project_file_comments enable row level security;
alter table public.project_file_events enable row level security;

create policy project_folders_select on public.project_folders for select to authenticated
  using (case when restricted then (select private.can_see_project_money(project_id)) else (select private.can_work_on_project(project_id)) end);
create policy project_folders_insert on public.project_folders for insert to authenticated
  with check (not restricted and (select private.can_work_on_project(project_id))
    and (parent_id is null or exists (select 1 from public.project_folders p where p.id = parent_id and p.project_id = project_folders.project_id and not p.restricted)));
create policy project_folders_update on public.project_folders for update to authenticated
  using (system_key is null and (select private.can_manage_project(project_id)));

create policy project_files_select on public.project_files for select to authenticated
  using ((select private.can_read_project_folder(folder_id)));
create policy project_files_update on public.project_files for update to authenticated
  using ((select private.can_read_project_folder(folder_id)) and ((select private.can_manage_project(project_id)) or created_by = (select auth.uid())))
  with check ((select private.can_read_project_folder(folder_id)));

create policy project_file_versions_select on public.project_file_versions for select to authenticated
  using (exists (select 1 from public.project_files f where f.id = file_id));

create policy project_file_comments_select on public.project_file_comments for select to authenticated
  using (exists (select 1 from public.project_file_versions v where v.id = version_id));
create policy project_file_comments_insert on public.project_file_comments for insert to authenticated
  with check (not from_client and author_id = (select auth.uid()) and exists (select 1 from public.project_file_versions v where v.id = version_id));
create policy project_file_comments_update on public.project_file_comments for update to authenticated
  using (exists (select 1 from public.project_file_versions v where v.id = version_id));

create policy project_file_events_select on public.project_file_events for select to authenticated
  using (exists (select 1 from public.project_files f where f.id = file_id));

revoke all on public.project_folders, public.project_files, public.project_file_versions, public.project_file_comments, public.project_file_events
  from anon, authenticated;
grant select on public.project_folders, public.project_files, public.project_file_versions, public.project_file_comments, public.project_file_events to authenticated;
grant insert (project_id, parent_id, name, position) on public.project_folders to authenticated;
grant update (name, position, archived_at) on public.project_folders to authenticated;
grant update (name, folder_id, phase_id, archived_at) on public.project_files to authenticated;
grant insert (version_id, project_id, page, x_pct, y_pct, body, author_id) on public.project_file_comments to authenticated;
grant update (resolved_at) on public.project_file_comments to authenticated;

-- Defaults and integrity for direct writes.
create function private.project_folders_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.name := btrim(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.parent_id := old.parent_id;
    new.system_key := old.system_key;
    new.restricted := old.restricted;
  end if;
  return new;
end $$;

create trigger project_folders_before_write before insert or update on public.project_folders
  for each row execute function private.project_folders_before_write();

create function private.project_files_before_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.id := old.id;
  new.project_id := old.project_id;
  new.kind := old.kind;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.name := btrim(new.name);
  new.updated_at := now();
  if new.folder_id is distinct from old.folder_id and not exists (
    select 1 from public.project_folders f join public.project_folders o on o.id = old.folder_id
    where f.id = new.folder_id and f.project_id = old.project_id and f.archived_at is null and f.restricted = o.restricted
  ) then
    raise exception 'invalid_move' using errcode = '22023';
  end if;
  if new.archived_at is distinct from old.archived_at then
    new.archived_by := case when new.archived_at is null then null else (select auth.uid()) end;
    insert into public.project_file_events (project_id, file_id, type, actor_id)
    values (old.project_id, old.id, case when new.archived_at is null then 'restored' else 'archived' end, (select auth.uid()));
  end if;
  return new;
end $$;

create trigger project_files_before_update before update on public.project_files
  for each row execute function private.project_files_before_update();

create function private.project_file_comments_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.project_id := (select v.project_id from public.project_file_versions v where v.id = new.version_id);
    new.created_at := now();
    new.body := btrim(new.body);
  else
    new.id := old.id;
    new.version_id := old.version_id;
    new.body := old.body;
    new.author_id := old.author_id;
    new.from_client := old.from_client;
    new.resolved_by := case when new.resolved_at is null then null else (select auth.uid()) end;
  end if;
  return new;
end $$;

create trigger project_file_comments_before_write before insert or update on public.project_file_comments
  for each row execute function private.project_file_comments_before_write();

-- ---------------------------------------------------------------------------
-- Listing
-- ---------------------------------------------------------------------------
create function public.list_project_folder(p_project_id uuid, p_folder_id uuid default null, p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;
  with f as (
    select fi.* from public.project_files fi
    where fi.project_id = p_project_id and fi.archived_at is null
      and (case when v_pattern is not null then true else fi.folder_id is not distinct from p_folder_id end)
      and (v_pattern is null or fi.name ilike v_pattern)
  ), page as (
    select f.*, row_number() over (order by f.updated_at desc, f.id) as rn from f order by rn limit p_limit offset p_offset
  )
  select (select count(*) from f),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id', pg.id, 'name', pg.name, 'kind', pg.kind, 'folder_id', pg.folder_id, 'updated_at', pg.updated_at, 'created_at', pg.created_at,
      'phase', (select jsonb_build_object('id', ph.id, 'name', ph.name) from public.project_phases ph where ph.id = pg.phase_id),
      'current', (select jsonb_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'size_bytes', v.size_bytes,
          'mime_type', v.mime_type, 'storage_path', v.storage_path, 'created_at', v.created_at,
          'uploaded_by', (select pr.display_name from public.profiles pr where pr.id = v.uploaded_by))
        from public.project_file_versions v where v.id = pg.current_version_id),
      'client_version', (select jsonb_build_object('version_no', v.version_no, 'status', v.status) from public.project_file_versions v
        where v.file_id = pg.id and (v.status in ('approved', 'client_approved') or (v.status = 'changes_requested' and v.client_comment is not null))
        order by v.version_no desc limit 1),
      'versions', (select count(*) from public.project_file_versions v where v.file_id = pg.id),
      'open_comments', (select count(*) from public.project_file_comments c join public.project_file_versions v on v.id = c.version_id
        where v.file_id = pg.id and c.resolved_at is null),
      'client_seen_at', (select max(e.created_at) from public.project_file_events e where e.file_id = pg.id and e.from_client)
    ) order by pg.rn) from page pg), '[]'::jsonb)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.project_file_detail(p_file_id uuid)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_file public.project_files%rowtype;
begin
  select * into v_file from public.project_files where id = p_file_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'file', jsonb_build_object('id', v_file.id, 'name', v_file.name, 'kind', v_file.kind, 'folder_id', v_file.folder_id,
      'project_id', v_file.project_id, 'current_version_id', v_file.current_version_id, 'archived_at', v_file.archived_at,
      'can_manage', private.can_manage_project(v_file.project_id)),
    'versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status,
        'size_bytes', v.size_bytes, 'mime_type', v.mime_type, 'original_name', v.original_name, 'note', v.note, 'client_comment', v.client_comment,
        'created_at', v.created_at, 'status_at', v.status_at, 'uploaded_by', (select pr.display_name from public.profiles pr where pr.id = v.uploaded_by),
        'uploaded_by_id', v.uploaded_by, 'status_by', (select pr.display_name from public.profiles pr where pr.id = v.status_by))
      order by v.version_no desc) from public.project_file_versions v where v.file_id = p_file_id), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'version_id', c.version_id, 'page', c.page, 'x_pct', c.x_pct, 'y_pct', c.y_pct,
        'body', c.body, 'from_client', c.from_client, 'created_at', c.created_at, 'resolved_at', c.resolved_at,
        'author', coalesce((select pr.display_name from public.profiles pr where pr.id = c.author_id), 'Client'))
      order by c.created_at) from public.project_file_comments c join public.project_file_versions v on v.id = c.version_id
      where v.file_id = p_file_id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'version_id', e.version_id, 'from_client', e.from_client,
        'comment', e.comment, 'created_at', e.created_at,
        'actor', coalesce((select pr.display_name from public.profiles pr where pr.id = e.actor_id), case when e.from_client then 'Client' end))
      order by e.created_at desc) from (select * from public.project_file_events x where x.file_id = p_file_id order by x.created_at desc limit 50) e), '[]'::jsonb)
  );
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.project_folders, public.project_files, public.project_file_versions,
      public.project_file_comments, public.project_file_events;
  end if;
end $$;

revoke all on function
  private.can_read_project_folder(uuid),
  private.can_write_project_folder(uuid),
  private.file_kind(text),
  private.seed_project_folders(),
  private.project_folders_before_write(),
  private.project_files_before_update(),
  private.project_file_comments_before_write(),
  public.project_storage_usage(uuid),
  public.register_project_file(uuid, text, text, uuid, text, uuid, uuid),
  public.set_file_version_status(uuid, text, text),
  public.list_project_folder(uuid, uuid, text, integer, integer),
  public.project_file_detail(uuid)
from public, anon, authenticated;

grant execute on function private.can_read_project_folder(uuid), private.can_write_project_folder(uuid) to authenticated, service_role;
grant execute on function
  public.project_storage_usage(uuid),
  public.register_project_file(uuid, text, text, uuid, text, uuid, uuid),
  public.set_file_version_status(uuid, text, text),
  public.list_project_folder(uuid, uuid, text, integer, integer),
  public.project_file_detail(uuid)
to authenticated;

-- Ledger lookup for the upload signer (service role): 'pending', 'confirmed' or null.
create function public.storage_object_state(p_bucket text, p_name text)
returns text
language sql stable security definer set search_path = ''
as $$
  select case when o.confirmed_at is null then 'pending' else 'confirmed' end
  from private.storage_objects o where o.bucket = p_bucket and o.name = p_name
$$;
revoke all on function public.storage_object_state(text, text) from public, anon, authenticated;
grant execute on function public.storage_object_state(text, text) to service_role;
