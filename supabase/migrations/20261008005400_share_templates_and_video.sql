-- ---------------------------------------------------------------------------
-- 1. Videos in the Library: MP4, WEBM and MOV up to 500 MB (documents and images stay at 25 MB).
--    They are stored and streamed straight from Tigris like every other library file.
-- 2. Share templates: a named set of library files + WhatsApp message + link expiry that fills
--    the "Share files on WhatsApp" window in one pick. Archived, never deleted.
-- Additive. library_files_before_write and admin_usage re-created from 20261007000200.
-- ---------------------------------------------------------------------------

-- 1. Videos ------------------------------------------------------------------

alter table public.library_files drop constraint library_files_mime_type_check;
alter table public.library_files add constraint library_files_mime_type_check check (mime_type in (
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'));
alter table public.library_files drop constraint library_files_size_bytes_check;
alter table public.library_files add constraint library_files_size_bytes_check check (
  size_bytes > 0 and size_bytes <= case when mime_type like 'video/%' then 524288000 else 26214400 end);

-- Same as 20261007000200, with the video extensions and types.
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
    if new.storage_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(pdf|png|jpg|jpeg|webp|mp4|webm|mov)$'
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
    if new.mime_type not in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime') then
      raise exception 'invalid_file_type' using errcode = '22023';
    end if;
    if new.size_bytes > (case when new.mime_type like 'video/%' then 524288000 else 26214400 end) then
      raise exception 'file_too_large' using errcode = '22023';
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

-- Same as 20261007000200, plus video_bytes.
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
        'image_bytes', coalesce(sum(f.size_bytes) filter (where f.mime_type like 'image/%'), 0),
        'video_bytes', coalesce(sum(f.size_bytes) filter (where f.mime_type like 'video/%'), 0)
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

-- 2. Share templates -----------------------------------------------------------

create table public.share_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null check (char_length(name) between 1 and 80),
  message text not null default '' check (char_length(message) <= 1000),
  expiry text not null default '7d' check (expiry in ('24h', '7d', '30d', 'never')),
  created_by uuid not null references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);

-- One active template per name in a company (archived ones may repeat a name).
create unique index share_templates_name_key on public.share_templates (company_id, lower(name)) where archived_at is null;
create index share_templates_company_idx on public.share_templates (company_id, archived_at, lower(name));

create table public.share_template_files (
  template_id uuid not null references public.share_templates (id) on delete cascade,
  file_id uuid not null references public.library_files (id),
  position smallint not null check (position between 0 and 9),
  primary key (template_id, file_id)
);
create index share_template_files_file_idx on public.share_template_files (file_id);

alter table public.share_templates enable row level security;
alter table public.share_template_files enable row level security;

-- Everyone who shares documents (admins and sales of the company) can read them; writes only via the RPCs.
create policy share_templates_select on public.share_templates for select to authenticated
  using ((select private.is_lead_user()) and company_id = (select private.current_company_id()));
create policy share_template_files_select on public.share_template_files for select to authenticated
  using (exists (
    select 1 from public.share_templates t
    where t.id = template_id and t.company_id = (select private.current_company_id()) and (select private.is_lead_user())
  ));

grant select on public.share_templates, public.share_template_files to authenticated;

-- Creates (p_id null) or edits a template, replacing its files in the given order. Any admin or sales
-- user may create one; only an admin or its creator may edit. Files must be active library files of
-- the same company. Returns the template id.
create or replace function public.save_share_template(
  p_id uuid, p_name text, p_message text, p_expiry text, p_file_ids uuid[]
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company uuid := private.current_company_id();
  v_name text := coalesce(private.clean_label(coalesce(p_name, '')), '');
  v_files uuid[] := coalesce(p_file_ids, '{}');
  v_template public.share_templates%rowtype;
  v_id uuid;
begin
  if v_uid is null or v_company is null or not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'template_name_required' using errcode = '22023';
  end if;
  if char_length(coalesce(p_message, '')) > 1000 then
    raise exception 'message_too_long' using errcode = '22023';
  end if;
  if p_expiry is null or p_expiry not in ('24h', '7d', '30d', 'never') then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  if cardinality(v_files) not between 1 and 10 or (select count(distinct x) from unnest(v_files) x) <> cardinality(v_files) then
    raise exception 'invalid_share_files' using errcode = '22023';
  end if;
  if (select count(*) from public.library_files f
      join public.library_folders d on d.id = f.folder_id
      where f.id = any(v_files) and f.archived_at is null and d.archived_at is null and f.company_id = v_company) <> cardinality(v_files) then
    raise exception 'share_file_unavailable' using errcode = '22023';
  end if;
  if exists (select 1 from public.share_templates t
             where t.company_id = v_company and t.archived_at is null and lower(t.name) = lower(v_name) and t.id is distinct from p_id) then
    raise exception 'template_name_taken' using errcode = '23505';
  end if;

  if p_id is null then
    insert into public.share_templates (company_id, name, message, expiry, created_by)
    values (v_company, v_name, btrim(coalesce(p_message, '')), p_expiry, v_uid)
    returning id into v_id;
  else
    select * into v_template from public.share_templates t where t.id = p_id and t.company_id = v_company for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if not private.is_admin() and v_template.created_by <> v_uid then
      perform private.raise_forbidden();
    end if;
    update public.share_templates
    set name = v_name, message = btrim(coalesce(p_message, '')), expiry = p_expiry, updated_by = v_uid, updated_at = now()
    where id = p_id;
    delete from public.share_template_files where template_id = p_id;
    v_id := p_id;
  end if;

  insert into public.share_template_files (template_id, file_id, position)
  select v_id, x.id, (x.ord - 1)::smallint from unnest(v_files) with ordinality as x(id, ord);
  return v_id;
end $$;

-- Archives (or restores) a template: an admin or its creator. Restoring checks the name is still free.
create or replace function public.set_share_template_archived(p_id uuid, p_archived boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_template public.share_templates%rowtype;
begin
  if v_uid is null or not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select * into v_template from public.share_templates t where t.id = p_id and t.company_id = private.current_company_id() for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.is_admin() and v_template.created_by <> v_uid then
    perform private.raise_forbidden();
  end if;
  if not p_archived and v_template.archived_at is not null and exists (
    select 1 from public.share_templates t
    where t.company_id = v_template.company_id and t.archived_at is null and lower(t.name) = lower(v_template.name)
  ) then
    raise exception 'template_name_taken' using errcode = '23505';
  end if;
  update public.share_templates
  set archived_at = case when p_archived then coalesce(archived_at, now()) else null end,
      archived_by = case when p_archived then coalesce(archived_by, v_uid) else null end,
      updated_by = v_uid, updated_at = now()
  where id = p_id;
end $$;

revoke all on function public.save_share_template(uuid, text, text, text, uuid[]), public.set_share_template_archived(uuid, boolean) from public, anon;
grant execute on function public.save_share_template(uuid, text, text, text, uuid[]), public.set_share_template_archived(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
