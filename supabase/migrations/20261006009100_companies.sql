-- Multi-company: one app, several companies with isolated data.
--
-- * Every business table carries company_id. Child tables (follow-ups, activities, shares,
--   stars, deliveries) stay scoped through their lead (private.can_access_lead).
-- * private.current_company_id() is the signed-in user's company, or the super admin's
--   active company (profiles.active_company_id, switched with set_active_company()).
-- * private.app_role() reports a super admin as 'admin', so every existing policy and RPC
--   treats them as the admin of the company they are working in.
-- * A guard trigger pins company_id on insert, keeps it immutable, and refuses writes to
--   another company's rows from user sessions, including through SECURITY DEFINER functions.
-- * Existing data becomes the "Star Growth Hub" company; the oldest active admin becomes
--   the super admin.

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------
create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80 and name = btrim(name)),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  -- One word of the name shown in the brand red, e.g. "Growth".
  brand_highlight text check (brand_highlight is null or char_length(brand_highlight) between 1 and 40),
  logo_path text check (logo_path is null or char_length(logo_path) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint companies_normalized_name_key unique (normalized_name)
);

create trigger companies_touch before update on public.companies
  for each row execute function private.touch_updated_at();

insert into public.companies (name, brand_highlight) values ('Star Growth Hub', 'Growth');

-- ---------------------------------------------------------------------------
-- Profiles: home company (null only for the super admin) and the super admin's active company
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column company_id uuid references public.companies (id),
  add column active_company_id uuid references public.companies (id) on delete set null;

update public.profiles set company_id = (select c.id from public.companies c order by c.created_at, c.id limit 1);

update public.profiles p
set role = 'super_admin', company_id = null, active_company_id = (select c.id from public.companies c order by c.created_at, c.id limit 1)
where p.id = (
  select x.id from public.profiles x where x.role = 'admin' and x.is_active order by x.created_at, x.id limit 1
);

alter table public.profiles add constraint profiles_company_check
  check ((role = 'super_admin') = (company_id is null));

create index profiles_company_role_idx on public.profiles (company_id, role, is_active);

alter table public.companies add constraint companies_created_by_fkey
  foreign key (created_by) references public.profiles (id);

-- ---------------------------------------------------------------------------
-- company_id on every business table
-- ---------------------------------------------------------------------------
do $$
declare
  v_company uuid := (select c.id from public.companies c order by c.created_at, c.id limit 1);
  t text;
begin
  foreach t in array array['leads', 'niches', 'library_folders', 'library_files', 'capital_entries',
                           'expenses', 'expense_recurrences', 'finance_activities'] loop
    execute format('alter table public.%I add column company_id uuid references public.companies (id)', t);
    execute format('update public.%I set company_id = $1', t) using v_company;
    execute format('alter table public.%I alter column company_id set not null', t);
  end loop;
end $$;

create index leads_company_created_idx on public.leads (company_id, created_at desc, id desc);
create index leads_company_phone_idx on public.leads (company_id, phone_normalized) where archived_at is null;
create index library_folders_company_idx on public.library_folders (company_id);
create index library_files_company_idx on public.library_files (company_id);
create index capital_entries_company_date_idx on public.capital_entries (company_id, entry_date desc);
create index expenses_company_date_idx on public.expenses (company_id, expense_date desc);
create index expense_recurrences_company_idx on public.expense_recurrences (company_id);
create index finance_activities_company_idx on public.finance_activities (company_id, created_at desc);

-- Names are unique within a company, not across companies.
alter table public.niches drop constraint niches_normalized_name_key;
alter table public.niches add constraint niches_company_normalized_name_key unique (company_id, normalized_name);

drop index public.library_folders_active_name_key;
create unique index library_folders_active_name_key on public.library_folders
  (company_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.is_super_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_active and p.role = 'super_admin'
  )
$$;

-- The company the signed-in user works in: their own (if not archived), or for the super
-- admin the active company, falling back to the oldest company.
create function private.current_company_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select case when p.role = 'super_admin' then coalesce(
      (select c.id from public.companies c where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1))
    else (select c.id from public.companies c where c.id = p.company_id and c.archived_at is null) end
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

-- Documents the intent (the guard trigger sets it anyway) and keeps company_id optional on inserts.
do $$
declare
  t text;
begin
  foreach t in array array['leads', 'niches', 'library_folders', 'library_files', 'capital_entries',
                           'expenses', 'expense_recurrences', 'finance_activities'] loop
    execute format('alter table public.%I alter column company_id set default private.current_company_id()', t);
  end loop;
end $$;

-- Effective role inside the current company. A super admin acts as that company's admin;
-- users of an archived company have no role.
create or replace function private.app_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select case when p.role = 'super_admin' then 'admin'::public.app_role else p.role end
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active and private.current_company_id() is not null
$$;

create or replace function private.can_access_lead(p_lead_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.leads l
    where l.id = p_lead_id
      and l.company_id = private.current_company_id()
      and (
        private.app_role() = 'admin'
        or (private.app_role() = 'sales' and l.owner_id = (select auth.uid()) and l.archived_at is null)
      )
  )
$$;

-- Company checks happen in private.company_guard (it knows the lead's company).
create or replace function private.assert_valid_owner(p_owner_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = p_owner_id and p.is_active and p.role in ('sales', 'admin', 'super_admin')
  ) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Guard: pins company_id on insert, keeps it immutable, and refuses user-session writes to
-- another company's rows (service role and cron jobs have no auth.uid() and are trusted).
-- Named zz_ so it runs after the other BEFORE triggers have settled owner/parent fields.
-- ---------------------------------------------------------------------------
create function private.company_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row record;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  elsif tg_op = 'UPDATE' then
    new.company_id := old.company_id;
    v_row := new;
  else
    if tg_table_name = 'library_files' then
      new.company_id := (select f.company_id from public.library_folders f where f.id = new.folder_id);
    elsif tg_table_name = 'finance_activities' then
      new.company_id := case new.entity_type
        when 'capital' then (select c.company_id from public.capital_entries c where c.id = new.entity_id)
        else (select e.company_id from public.expenses e where e.id = new.entity_id) end;
    elsif tg_table_name = 'expenses' then
      if new.recurrence_id is not null and new.company_id is null then
        new.company_id := (select r.company_id from public.expense_recurrences r where r.id = new.recurrence_id);
      end if;
    end if;
    if v_uid is not null then
      new.company_id := coalesce(new.company_id, private.current_company_id());
    end if;
    v_row := new;
  end if;

  if v_uid is not null and not private.is_super_admin()
     and v_row.company_id is distinct from private.current_company_id() then
    perform private.raise_forbidden();
  end if;

  if tg_op <> 'DELETE' and tg_table_name = 'leads' then
    if (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) and not exists (
      select 1 from public.profiles p
      where p.id = new.owner_id and (p.company_id = new.company_id or p.role = 'super_admin')
    ) then
      raise exception 'invalid_owner' using errcode = '22023';
    end if;
    if (tg_op = 'INSERT' or new.niche_id is distinct from old.niche_id) and not exists (
      select 1 from public.niches n where n.id = new.niche_id and n.company_id = new.company_id
    ) then
      raise exception 'niche_not_found' using errcode = 'P0002';
    end if;
  elsif tg_op = 'INSERT' and tg_table_name = 'library_folders' then
    if new.parent_id is not null and not exists (
      select 1 from public.library_folders f where f.id = new.parent_id and f.company_id = new.company_id
    ) then
      raise exception 'folder_not_found' using errcode = 'P0002';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['leads', 'niches', 'library_folders', 'capital_entries', 'expenses',
                           'expense_recurrences', 'finance_activities'] loop
    execute format('create trigger zz_company_guard before insert or update on public.%I
      for each row execute function private.company_guard()', t);
  end loop;
end $$;
create trigger zz_company_guard before insert or update or delete on public.library_files
  for each row execute function private.company_guard();

-- A document can only be shared on a lead of the same company.
create function private.lead_share_files_company_check()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.lead_shares s
    join public.leads l on l.id = s.lead_id
    join public.library_files f on f.id = new.file_id and f.company_id = l.company_id
    where s.id = new.share_id
  ) then
    raise exception 'share_file_unavailable' using errcode = 'P0002';
  end if;
  return new;
end $$;

create trigger lead_share_files_company_check before insert or update of file_id on public.lead_share_files
  for each row execute function private.lead_share_files_company_check();

-- Niche lookups and creation are per company (the guard sets company_id before the conflict check).
create or replace function private.resolve_niche(p_niche_id uuid, p_new_niche text)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
  v_archived timestamptz;
  v_merged uuid;
  v_label text := private.clean_label(p_new_niche);
  v_company uuid := private.current_company_id();
begin
  if p_niche_id is null then
    if v_label is null then
      raise exception 'niche_required' using errcode = '22023';
    end if;
    if char_length(v_label) > 60 then
      raise exception 'niche_too_long' using errcode = '22023';
    end if;
    insert into public.niches (name) values (v_label)
      on conflict (company_id, normalized_name) do nothing
      returning id into v_id;
    if v_id is not null then
      return v_id;
    end if;
    select n.id into p_niche_id from public.niches n
      where n.company_id = v_company and n.normalized_name = lower(v_label);
  end if;

  select n.id, n.archived_at, n.merged_into_id into v_id, v_archived, v_merged
    from public.niches n where n.id = p_niche_id and n.company_id = v_company;
  if v_id is null then
    raise exception 'niche_not_found' using errcode = 'P0002';
  end if;
  if v_merged is not null then
    return v_merged;
  end if;
  if v_archived is not null then
    raise exception 'niche_archived' using errcode = '22023';
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security: add the company to every company-owned table
-- ---------------------------------------------------------------------------
alter table public.companies enable row level security;
create policy companies_select on public.companies for select to authenticated
  using ((select private.is_super_admin()) or id = (select private.current_company_id()));

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.app_role()) is not null
        and (company_id = (select private.current_company_id()) or role = 'super_admin'))
  );

drop policy admin_audit_log_select on public.admin_audit_log;
create policy admin_audit_log_select on public.admin_audit_log for select to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_admin()) and exists (
      select 1 from public.profiles p
      where p.id = admin_audit_log.target_user_id and p.company_id = (select private.current_company_id())))
  );

drop policy niches_select on public.niches;
drop policy niches_insert on public.niches;
drop policy niches_update on public.niches;
create policy niches_select on public.niches for select to authenticated
  using ((select private.is_lead_user()) and company_id = (select private.current_company_id()));
create policy niches_insert on public.niches for insert to authenticated
  with check ((select private.is_lead_user()) and company_id = (select private.current_company_id())
    and archived_at is null and merged_into_id is null);
create policy niches_update on public.niches for update to authenticated
  using ((select private.is_admin()) and company_id = (select private.current_company_id()))
  with check ((select private.is_admin()) and company_id = (select private.current_company_id()));

drop policy leads_select on public.leads;
drop policy leads_insert on public.leads;
drop policy leads_update on public.leads;
create policy leads_select on public.leads for select to authenticated
  using (
    company_id = (select private.current_company_id())
    and ((select private.app_role()) = 'admin'
      or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and archived_at is null))
  );
create policy leads_insert on public.leads for insert to authenticated
  with check (
    company_id = (select private.current_company_id())
    and ((select private.app_role()) = 'admin'
      or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and created_by = (select auth.uid())))
  );
create policy leads_update on public.leads for update to authenticated
  using (
    company_id = (select private.current_company_id())
    and ((select private.app_role()) = 'admin'
      or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and archived_at is null))
  )
  with check (
    company_id = (select private.current_company_id())
    and ((select private.app_role()) = 'admin'
      or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and archived_at is null))
  );

drop policy library_folders_select on public.library_folders;
drop policy library_folders_insert on public.library_folders;
drop policy library_folders_update on public.library_folders;
create policy library_folders_select on public.library_folders for select to authenticated
  using ((select private.is_lead_user()) and company_id = (select private.current_company_id()));
create policy library_folders_insert on public.library_folders for insert to authenticated
  with check ((select private.is_lead_user()) and company_id = (select private.current_company_id())
    and created_by = (select auth.uid()));
create policy library_folders_update on public.library_folders for update to authenticated
  using ((select private.is_admin()) and company_id = (select private.current_company_id()))
  with check ((select private.is_admin()) and company_id = (select private.current_company_id()));

drop policy library_files_select on public.library_files;
drop policy library_files_insert on public.library_files;
drop policy library_files_update on public.library_files;
create policy library_files_select on public.library_files for select to authenticated
  using ((select private.is_lead_user()) and company_id = (select private.current_company_id()));
create policy library_files_insert on public.library_files for insert to authenticated
  with check ((select private.is_lead_user()) and company_id = (select private.current_company_id())
    and created_by = (select auth.uid()));
create policy library_files_update on public.library_files for update to authenticated
  using ((select private.is_admin()) and company_id = (select private.current_company_id()))
  with check ((select private.is_admin()) and company_id = (select private.current_company_id()));

-- Storage objects live under "<folder_id>/…"; the folder lookup is itself company-scoped by RLS.
drop policy library_objects_select on storage.objects;
create policy library_objects_select on storage.objects for select to authenticated
  using (
    bucket_id = 'library'
    and (select private.is_lead_user())
    and exists (select 1 from public.library_folders f where f.id::text = (storage.foldername(objects.name))[1])
  );

drop policy library_objects_delete on storage.objects;
create policy library_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'library'
    and (select private.is_admin())
    and (
      (select private.is_super_admin())
      or exists (select 1 from public.library_folders d where d.id::text = (storage.foldername(objects.name))[1])
    )
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

drop policy capital_entries_select on public.capital_entries;
drop policy capital_entries_insert on public.capital_entries;
drop policy capital_entries_update on public.capital_entries;
create policy capital_entries_select on public.capital_entries for select to authenticated
  using ((select private.is_finance_user()) and company_id = (select private.current_company_id()));
create policy capital_entries_insert on public.capital_entries for insert to authenticated
  with check ((select private.is_finance_user()) and company_id = (select private.current_company_id())
    and created_by = (select auth.uid()));
create policy capital_entries_update on public.capital_entries for update to authenticated
  using ((select private.is_finance_user()) and company_id = (select private.current_company_id()))
  with check ((select private.is_finance_user()) and company_id = (select private.current_company_id()));

drop policy expenses_select on public.expenses;
drop policy expenses_insert on public.expenses;
drop policy expenses_update on public.expenses;
create policy expenses_select on public.expenses for select to authenticated
  using ((select private.is_finance_user()) and company_id = (select private.current_company_id()));
create policy expenses_insert on public.expenses for insert to authenticated
  with check ((select private.is_finance_user()) and company_id = (select private.current_company_id())
    and created_by = (select auth.uid()));
create policy expenses_update on public.expenses for update to authenticated
  using ((select private.is_finance_user()) and company_id = (select private.current_company_id()))
  with check ((select private.is_finance_user()) and company_id = (select private.current_company_id()));

drop policy expense_recurrences_select on public.expense_recurrences;
create policy expense_recurrences_select on public.expense_recurrences for select to authenticated
  using ((select private.is_finance_user()) and company_id = (select private.current_company_id()));

drop policy finance_activities_select on public.finance_activities;
create policy finance_activities_select on public.finance_activities for select to authenticated
  using ((select private.is_finance_user()) and company_id = (select private.current_company_id()));

-- ---------------------------------------------------------------------------
-- Users: created into a company; managed only within it
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role;
  v_company uuid;
begin
  if new.raw_app_meta_data ? 'crm_role'
     and not exists (select 1 from public.profiles p where p.id = new.id) then
    v_role := (new.raw_app_meta_data ->> 'crm_role')::public.app_role;
    if v_role <> 'super_admin' then
      v_company := nullif(new.raw_app_meta_data ->> 'crm_company_id', '')::uuid;
      if v_company is null or not exists (select 1 from public.companies c where c.id = v_company and c.archived_at is null) then
        raise exception 'company_required' using errcode = '23514';
      end if;
    end if;
    insert into public.profiles (id, username, display_name, role, company_id, active_company_id)
    values (
      new.id,
      new.raw_app_meta_data ->> 'crm_username',
      btrim(new.raw_app_meta_data ->> 'crm_display_name'),
      v_role,
      v_company,
      case when v_role = 'super_admin'
        then (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1) end
    );
    insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
    values (
      (select p.id from public.profiles p
        where p.id = nullif(new.raw_app_meta_data ->> 'crm_created_by', '')::uuid),
      new.id,
      'user_created',
      jsonb_strip_nulls(jsonb_build_object('role', v_role, 'company_id', v_company))
    );
  end if;
  return new;
end $$;

-- Target must be in the caller's current company. Nobody becomes or edits a super admin here.
-- Each company keeps at least one active admin unless the super admin makes the change.
create or replace function public.admin_update_user(
  p_user_id uuid,
  p_display_name text default null,
  p_role public.app_role default null,
  p_is_active boolean default null
)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.profiles%rowtype;
  v_new public.profiles%rowtype;
  v_company uuid := private.current_company_id();
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_role = 'super_admin' then
    perform private.raise_forbidden();
  end if;

  -- Serialize admin changes so two concurrent demotions cannot remove a company's last admin.
  perform 1 from public.profiles where company_id = v_company and role = 'admin' and is_active for update;

  select * into v_old from public.profiles where id = p_user_id for update;
  if not found or v_old.company_id is distinct from v_company then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update public.profiles set
    display_name = coalesce(private.clean_label(p_display_name), display_name),
    role = coalesce(p_role, role),
    is_active = coalesce(p_is_active, is_active)
  where id = p_user_id
  returning * into v_new;

  if v_old.role = 'admin' and v_old.is_active and (v_new.role <> 'admin' or not v_new.is_active)
     and not private.is_super_admin()
     and not exists (select 1 from public.profiles p where p.company_id = v_company and p.role = 'admin' and p.is_active) then
    raise exception 'last_admin' using errcode = '23514';
  end if;

  if v_new.role not in ('sales', 'admin') and v_new.role <> v_old.role and exists (
    select 1 from public.leads l where l.owner_id = p_user_id and l.archived_at is null
  ) then
    raise exception 'reassign_leads_first' using errcode = '23514';
  end if;

  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'user_updated', jsonb_strip_nulls(jsonb_build_object(
    'display_name', case when v_new.display_name <> v_old.display_name then jsonb_build_object('from', v_old.display_name, 'to', v_new.display_name) end,
    'role', case when v_new.role <> v_old.role then jsonb_build_object('from', v_old.role, 'to', v_new.role) end,
    'is_active', case when v_new.is_active <> v_old.is_active then jsonb_build_object('from', v_old.is_active, 'to', v_new.is_active) end
  )));
  return v_new;
end $$;

create or replace function public.admin_list_users(
  p_search text default null,
  p_role public.app_role default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
  v_company uuid := private.current_company_id();
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select p.* from public.profiles p
    where p.company_id = v_company
      and (p_role is null or p.role = p_role)
      and (v_pattern is null or p.username ilike v_pattern or p.display_name ilike v_pattern)
  ), page as (
    select f.*, row_number() over (order by f.is_active desc, lower(f.display_name), f.id) as rn
    from filtered f
    order by rn
    limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'username', pg.username, 'display_name', pg.display_name, 'role', pg.role,
      'is_active', pg.is_active, 'created_at', pg.created_at,
      'owned_active_leads', (select count(*) from public.leads l where l.owner_id = pg.id and l.archived_at is null)
    ) order by pg.rn), '[]'::jsonb) from page pg)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Also the authorization check before the server resets the Auth password.
create or replace function public.admin_log_password_reset(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() or not exists (
    select 1 from public.profiles p where p.id = p_user_id and p.company_id = private.current_company_id()
  ) then
    perform private.raise_forbidden();
  end if;
  insert into public.admin_audit_log (actor_id, target_user_id, action)
  values ((select auth.uid()), p_user_id, 'password_reset');
end $$;

-- Duplicates are detected within the current company only.
create or replace function public.check_duplicate_phone(p_phone_normalized text, p_exclude_lead_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_visible uuid;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select array_agg(l.id) into v_ids from (
    select l.id from public.leads l
    where l.company_id = private.current_company_id()
      and l.phone_normalized = p_phone_normalized
      and l.archived_at is null
      and (p_exclude_lead_id is null or l.id <> p_exclude_lead_id)
    limit 20
  ) l;
  if v_ids is null then
    return jsonb_build_object('duplicate', false);
  end if;
  select id into v_visible from unnest(v_ids) as id where private.can_access_lead(id) limit 1;
  return jsonb_build_object('duplicate', true, 'visible_lead_id', v_visible);
end $$;

-- Admins (and the super admin) keep their stars on reassignment.
create or replace function private.leads_cleanup_stars()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    delete from public.lead_stars s where s.lead_id = new.id;
    delete from public.follow_up_stars s using public.follow_ups f
      where f.id = s.follow_up_id and f.lead_id = new.id;
  elsif new.owner_id is distinct from old.owner_id then
    delete from public.lead_stars s using public.profiles p
      where s.lead_id = new.id and p.id = s.user_id and p.role not in ('admin', 'super_admin') and s.user_id <> new.owner_id;
    delete from public.follow_up_stars s using public.follow_ups f, public.profiles p
      where f.id = s.follow_up_id and f.lead_id = new.id
        and p.id = s.user_id and p.role not in ('admin', 'super_admin') and s.user_id <> new.owner_id;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Storage usage is project-wide: super admin only
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
-- Notifications: fan-out stays inside the company. The super admin gets the admin kinds
-- for every company, with the company name added to the message.
-- ---------------------------------------------------------------------------
create or replace function private.notification_kinds_for(p_role public.app_role)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_role
    when 'admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'test']
    when 'super_admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'test']
    when 'sales' then array['lead_assigned', 'follow_up_changed', 'overdue_nag', 'library_file_added', 'digest_sales', 'test']
    when 'account' then array['expense_added', 'capital_added', 'recurring_expense', 'digest_finance', 'test']
    else array[]::text[] end
$$;

create function private.enqueue_for_company(
  p_company_id uuid, p_roles public.app_role[], p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer := 0;
  v_company text := (select c.name from public.companies c where c.id = p_company_id);
  r record;
begin
  for r in
    select p.id, p.role from public.profiles p
    where p.is_active and (
      (p.company_id = p_company_id and p.role = any(p_roles))
      or (p.role = 'super_admin' and 'admin' = any(p_roles))
    )
  loop
    if private.enqueue_notification(r.id, p_kind,
         case when r.role = 'super_admin' then p_payload || jsonb_build_object('company', v_company, 'company_id', p_company_id) else p_payload end,
         p_dedupe, p_actor, p_lead_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

create or replace function private.notify_lead_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
  v_fu public.follow_ups%rowtype;
  v_base jsonb;
begin
  if new.type::text not in ('lead_created', 'status_changed', 'assigned', 'follow_up_scheduled', 'follow_up_rescheduled') then
    return null;
  end if;
  select * into v_lead from public.leads l where l.id = new.lead_id;
  if not found or v_lead.archived_at is not null then
    return null;
  end if;
  v_base := jsonb_build_object(
    'lead_id', v_lead.id, 'lead_name', v_lead.name, 'actor', private.display_name(new.actor_id),
    'owner', private.display_name(v_lead.owner_id),
    'niche', (select n.name from public.niches n where n.id = v_lead.niche_id));

  if new.type = 'lead_created' then
    perform private.enqueue_for_company(v_lead.company_id, array['admin']::public.app_role[], 'lead_created',
      v_base || jsonb_build_object('status', v_lead.status), 'lead_created:' || v_lead.id, new.actor_id, v_lead.id);
    -- Created by someone else on the owner's behalf.
    perform private.enqueue_notification(v_lead.owner_id, 'lead_assigned',
      v_base || jsonb_build_object('phone', v_lead.phone), 'lead_assigned:' || new.id, new.actor_id, v_lead.id);
  elsif new.type = 'assigned' then
    perform private.enqueue_notification(v_lead.owner_id, 'lead_assigned',
      v_base || jsonb_build_object('phone', v_lead.phone, 'from', new.meta ->> 'from'), 'lead_assigned:' || new.id,
      new.actor_id, v_lead.id);
  elsif new.type = 'status_changed' then
    if coalesce(new.meta ->> 'to_kind', new.meta ->> 'to') in ('won', 'lost') then
      perform private.enqueue_for_company(v_lead.company_id, array['admin']::public.app_role[], 'lead_closed',
        v_base || jsonb_build_object('status', coalesce(new.meta ->> 'to_kind', new.meta ->> 'to'), 'stage', new.meta ->> 'to'), 'lead_closed:' || new.id, new.actor_id, v_lead.id);
    end if;
  else
    select * into v_fu from public.follow_ups f where f.id = new.follow_up_id;
    if found and v_fu.state = 'pending' then
      perform private.enqueue_notification(v_fu.assignee_id, 'follow_up_changed',
        v_base || jsonb_build_object('follow_up_id', v_fu.id, 'task', v_fu.task, 'due_at', v_fu.due_at,
          'rescheduled', new.type = 'follow_up_rescheduled'),
        'follow_up_changed:' || new.id, new.actor_id, v_lead.id, v_fu.id);
    end if;
  end if;
  return null;
end $$;

create or replace function private.notify_finance_entry()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'expenses' then
    -- Recurring expenses already send their own 'recurring_expense' notice.
    if new.recurrence_id is not null then
      return null;
    end if;
    perform private.enqueue_for_company(new.company_id, array['admin', 'account']::public.app_role[], 'expense_added',
      jsonb_build_object('id', new.id, 'date', new.expense_date, 'category', new.category, 'amount', new.amount,
        'item', new.item, 'quantity', new.quantity, 'payment_mode', new.payment_mode, 'description', new.description,
        'actor', private.display_name(new.created_by)),
      'expense_added:' || new.id, new.created_by);
  else
    perform private.enqueue_for_company(new.company_id, array['admin', 'account']::public.app_role[], 'capital_added',
      jsonb_build_object('id', new.id, 'date', new.entry_date, 'contributor', new.contributor, 'amount', new.amount,
        'item', new.item, 'quantity', new.quantity, 'payment_mode', new.payment_mode, 'description', new.description,
        'actor', private.display_name(new.created_by)),
      'capital_added:' || new.id, new.created_by);
  end if;
  return null;
end $$;

create or replace function private.notify_library_file()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_for_company(new.company_id, array['admin', 'sales']::public.app_role[], 'library_file_added',
    jsonb_build_object('id', new.id, 'name', new.name, 'folder_id', new.folder_id,
      'folder', (select f.name from public.library_folders f where f.id = new.folder_id),
      'actor', private.display_name(new.created_by)),
    'library_file_added:' || new.id, new.created_by);
  return null;
end $$;

create or replace function private.generate_recurring_expenses()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  r public.expense_recurrences%rowtype;
  v_date date;
  v_expense uuid;
  v_added integer := 0;
  v_runs integer;
begin
  for r in
    select * from public.expense_recurrences x where x.active and x.next_date <= v_today
    order by x.next_date, x.id for update skip locked
  loop
    v_date := r.next_date;
    v_runs := 0;
    while v_date <= v_today and v_runs < 12 loop
      v_expense := null;
      insert into public.expenses (expense_date, category, amount, payment_mode, item, quantity, description, created_by, recurrence_id, company_id)
      values (v_date, r.category, r.amount, r.payment_mode, r.item, r.quantity, r.description, r.created_by, r.id, r.company_id)
      on conflict (recurrence_id, expense_date) where recurrence_id is not null do nothing
      returning id into v_expense;

      if v_expense is not null then
        v_added := v_added + 1;
        perform private.enqueue_for_company(r.company_id, array['admin', 'account']::public.app_role[], 'recurring_expense',
          jsonb_build_object('expense_id', v_expense, 'date', v_date, 'category', r.category, 'amount', r.amount,
            'item', r.item, 'quantity', r.quantity, 'payment_mode', r.payment_mode, 'description', r.description),
          'recurring_expense:' || v_expense);
      end if;

      v_date := private.next_month_on_day(v_date, r.day_of_month);
      v_runs := v_runs + 1;
    end loop;
    update public.expense_recurrences set next_date = v_date, updated_at = now() where id = r.id;
  end loop;
  return v_added;
end $$;

create or replace function private.enqueue_digests(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_day date := v_local::date;
  v_hour integer := extract(hour from v_local);
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_day_end timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_month_start date := date_trunc('month', v_day)::date;
  v_prev_month date := (date_trunc('month', v_day) - interval '1 month')::date;
  v_count integer := 0;
  v_today integer;
  v_overdue integer;
  v_tasks jsonb;
  v_rows jsonb;
  v_payload jsonb;
  r record;
  c record;
begin
  -- Sales (and admins who own tasks): today's tasks and overdue count, 09:00–11:59 IST.
  if v_hour between 9 and 11 then
    for r in select p.id from public.profiles p where p.is_active and p.role in ('sales', 'admin', 'super_admin') loop
      select count(*) filter (where f.due_at >= v_day_start and f.due_at < v_day_end),
             count(*) filter (where f.due_at < p_now)
        into v_today, v_overdue
      from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.assignee_id = r.id and f.state = 'pending';
      continue when v_today + v_overdue = 0;
      select coalesce(jsonb_agg(t order by t.due_at, t.id), '[]'::jsonb) into v_tasks from (
        select f.id, f.task, f.due_at, l.id as lead_id, l.name as lead_name, f.due_at < p_now as overdue
        from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where f.assignee_id = r.id and f.state = 'pending' and f.due_at < v_day_end
        order by f.due_at, f.id limit 10
      ) t;
      if private.enqueue_notification(r.id, 'digest_sales',
        jsonb_build_object('date', v_day, 'today', v_today, 'overdue', v_overdue, 'tasks', v_tasks),
        'digest_sales:' || v_day) then
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  for c in select x.id from public.companies x where x.archived_at is null order by x.created_at, x.id loop
    -- Admin team report, 20:00–22:59 IST.
    if v_hour between 20 and 22 then
      select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) into v_rows from (
        select p.display_name as name,
          (select count(*) from public.leads l where l.owner_id = p.id and l.archived_at is null
             and l.status not in ('won', 'lost')) as active,
          (select count(*) from public.leads l where l.owner_id = p.id
             and l.created_at >= v_day_start and l.created_at < v_day_end) as new_today,
          (select count(*) from public.follow_ups f where f.assignee_id = p.id and f.state = 'completed'
             and f.completed_at >= v_day_start and f.completed_at < v_day_end) as done_today,
          (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
             where f.assignee_id = p.id and f.state = 'pending' and f.due_at < p_now) as overdue,
          (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id
             where l.owner_id = p.id and a.type = 'status_changed' and coalesce(a.meta ->> 'to_kind', a.meta ->> 'to') = 'won'
               and a.created_at >= v_day_start and a.created_at < v_day_end) as won_today,
          (select count(*) from public.lead_activities a where a.actor_id = p.id
             and a.created_at >= v_day_start and a.created_at < v_day_end) as actions_today,
          (select max(a.created_at) from public.lead_activities a where a.actor_id = p.id) as last_activity
        from public.profiles p
        where p.is_active and p.role = 'sales' and p.company_id = c.id
      ) x;
      v_count := v_count + private.enqueue_for_company(c.id, array['admin']::public.app_role[], 'digest_admin',
        jsonb_build_object('date', v_day, 'rows', v_rows), 'digest_admin:' || v_day || ':' || c.id);
    end if;

    -- Monthly finance summary for the previous month, 1st of the month 09:00–11:59 IST.
    if extract(day from v_local) = 1 and v_hour between 9 and 11 then
      select jsonb_build_object(
        'month', to_char(v_prev_month, 'YYYY-MM'),
        'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.company_id = c.id and e.archived_at is null
          and e.expense_date >= v_prev_month and e.expense_date < v_month_start), 0),
        'expense_count', (select count(*) from public.expenses e where e.company_id = c.id and e.archived_at is null
          and e.expense_date >= v_prev_month and e.expense_date < v_month_start),
        'categories', coalesce((select jsonb_agg(x order by x.total desc) from (
          select e.category, sum(e.amount) as total from public.expenses e
          where e.company_id = c.id and e.archived_at is null and e.expense_date >= v_prev_month and e.expense_date < v_month_start
          group by e.category) x), '[]'::jsonb),
        'capital_total', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id = c.id and k.archived_at is null
          and k.entry_date >= v_prev_month and k.entry_date < v_month_start), 0)
      ) into v_payload;
      v_count := v_count + private.enqueue_for_company(c.id, array['admin', 'account']::public.app_role[], 'digest_finance',
        v_payload, 'digest_finance:' || to_char(v_prev_month, 'YYYY-MM') || ':' || c.id);
    end if;
  end loop;
  return v_count;
end $$;

-- Delivery recheck: a company admin only gets lead alerts for their own company.
create or replace function public.claim_due_notifications(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (notification_id uuid, lease_token uuid, chat_id bigint, kind text, payload jsonb, attempts integer)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_max_attempts constant integer := 5;
  r record;
  v_token uuid;
  v_skip text;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);
  for r in
    select n.id, n.kind, n.payload, n.attempts, n.lead_id, n.follow_up_id, n.created_at, n.recipient_id,
      p.is_active, p.role, p.company_id, t.chat_id as t_chat, t.status as t_status, s.disabled_kinds
    from public.telegram_notifications n
    join public.profiles p on p.id = n.recipient_id
    left join public.telegram_connections t on t.user_id = n.recipient_id
    left join public.notification_settings s on s.user_id = n.recipient_id
    where n.state in ('pending', 'processing') and n.next_attempt_at <= now()
    order by n.next_attempt_at, n.id
    limit p_limit
    for update of n skip locked
  loop
    v_skip := null;
    if not r.is_active or not (r.kind = any(private.notification_kinds_for(r.role))) then
      v_skip := 'recipient_inactive';
    elsif r.kind <> 'test' and r.kind = any(coalesce(r.disabled_kinds, '{}')) then
      v_skip := 'disabled_by_user';
    elsif r.lead_id is not null and not exists (
      select 1 from public.leads l
      where l.id = r.lead_id and l.archived_at is null
        and (r.role = 'super_admin' or (r.role = 'admin' and l.company_id = r.company_id) or l.owner_id = r.recipient_id)) then
      v_skip := 'no_lead_access';
    elsif r.kind = 'overdue_nag' and (r.created_at < now() - interval '10 minutes' or not exists (
      select 1 from public.follow_ups f
      where f.id = r.follow_up_id and f.state = 'pending' and f.due_at < now()
        and f.assignee_id = r.recipient_id and f.revision = (r.payload ->> 'revision')::integer
        and not exists (select 1 from public.follow_up_nag_silences x where x.follow_up_id = f.id and x.revision = f.revision))) then
      v_skip := 'no_longer_overdue';
    end if;
    if v_skip is not null then
      update public.telegram_notifications
        set state = case when r.kind = 'overdue_nag' then 'cancelled' else 'skipped' end::public.reminder_state,
            last_error = v_skip, lease_token = null
        where id = r.id;
      continue;
    end if;
    if r.attempts >= v_max_attempts then
      update public.telegram_notifications set state = 'failed', last_error = coalesce(last_error, 'max_attempts_reached'), lease_token = null where id = r.id;
      continue;
    end if;
    if r.t_chat is null or r.t_status <> 'connected' then
      update public.telegram_notifications set state = 'failed', lease_token = null,
        last_error = case when r.t_chat is null then 'telegram_not_connected' else 'telegram_blocked' end
      where id = r.id;
      continue;
    end if;
    v_token := gen_random_uuid();
    update public.telegram_notifications set state = 'processing', attempts = attempts + 1, lease_token = v_token,
      next_attempt_at = now() + make_interval(secs => p_lease_seconds)
    where id = r.id;
    notification_id := r.id;
    lease_token := v_token;
    chat_id := r.t_chat;
    kind := r.kind;
    payload := r.payload;
    attempts := r.attempts + 1;
    return next;
  end loop;
end $$;

drop function private.enqueue_for_roles(public.app_role[], text, jsonb, text, uuid, uuid);

-- ---------------------------------------------------------------------------
-- Company management (super admin)
-- ---------------------------------------------------------------------------
create function public.set_active_company(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.profiles set active_company_id = p_company_id where id = (select auth.uid());
end $$;

create function public.create_company(p_name text, p_brand_highlight text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  insert into public.companies (name, brand_highlight, created_by)
  values (private.clean_label(p_name), private.clean_label(p_brand_highlight), (select auth.uid()))
  returning id into v_id;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'company_created', jsonb_build_object('company_id', v_id, 'name', private.clean_label(p_name)));
  return v_id;
exception when unique_violation then
  raise exception 'company_name_taken' using errcode = '23505';
end $$;

create function public.update_company(
  p_company_id uuid,
  p_name text default null,
  p_brand_highlight text default null,
  p_logo_path text default null,
  p_clear_logo boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.companies%rowtype;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_old from public.companies c where c.id = p_company_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_logo_path is not null and p_logo_path !~ ('^' || p_company_id::text || '/[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$') then
    raise exception 'invalid_file' using errcode = '22023';
  end if;
  update public.companies set
    name = coalesce(private.clean_label(p_name), name),
    brand_highlight = case when p_brand_highlight is null then brand_highlight else private.clean_label(p_brand_highlight) end,
    logo_path = case when coalesce(p_clear_logo, false) then null else coalesce(p_logo_path, logo_path) end
  where id = p_company_id;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'company_updated', jsonb_build_object('company_id', p_company_id));
exception when unique_violation then
  raise exception 'company_name_taken' using errcode = '23505';
end $$;

-- Companies with their size, for Super settings.
create function public.super_list_companies()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'brand_highlight', c.brand_highlight, 'logo_path', c.logo_path,
      'created_at', c.created_at, 'archived_at', c.archived_at,
      'users', (select count(*) from public.profiles p where p.company_id = c.id and p.is_active),
      'admins', (select count(*) from public.profiles p where p.company_id = c.id and p.is_active and p.role = 'admin'),
      'leads', (select count(*) from public.leads l where l.company_id = c.id and l.archived_at is null)
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c
  );
end $$;

-- A lead link opened by the super admin while another company is active: which company is it in?
create function public.super_lead_company(p_lead_id uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select l.company_id from public.leads l
  join public.companies c on c.id = l.company_id and c.archived_at is null
  where l.id = p_lead_id and private.is_super_admin()
$$;

-- Brand shown on a public document page (anon): the lead's company name and logo.
create function public.share_brand(p_token text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('name', c.name, 'brand_highlight', c.brand_highlight, 'logo_path', c.logo_path)
  from public.lead_shares s
  join public.leads l on l.id = s.lead_id
  join public.companies c on c.id = l.company_id
  where s.id = private.live_share_id(p_token)
$$;

-- ---------------------------------------------------------------------------
-- Company logos: public bucket (logos are not sensitive), written by the super admin only.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('company-logos', 'company-logos', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;

create policy company_logos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'company-logos' and (select private.is_super_admin()));
create policy company_logos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'company-logos' and (select private.is_super_admin()));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.companies from anon, authenticated;
grant select on public.companies to authenticated;

revoke all on function
  private.is_super_admin(),
  private.current_company_id(),
  private.company_guard(),
  private.lead_share_files_company_check(),
  private.enqueue_for_company(uuid, public.app_role[], text, jsonb, text, uuid, uuid),
  public.set_active_company(uuid),
  public.create_company(text, text),
  public.update_company(uuid, text, text, text, boolean),
  public.super_list_companies(),
  public.super_lead_company(uuid),
  public.share_brand(text)
from public, anon, authenticated;

grant execute on function private.is_super_admin(), private.current_company_id() to authenticated, service_role;
grant execute on function
  public.set_active_company(uuid),
  public.create_company(text, text),
  public.update_company(uuid, text, text, text, boolean),
  public.super_list_companies(),
  public.super_lead_company(uuid)
to authenticated;
grant execute on function public.share_brand(text) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.companies;
  end if;
end $$;
