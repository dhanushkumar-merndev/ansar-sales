-- ---------------------------------------------------------------------------
-- Admins across companies. Like sales users (20261008004200), the super admin gives an admin other companies
-- of ours (Super settings → Team across companies). They switch there at the top left and are a full Admin:
-- leads, reassigning, finance, settings and that company's users. They also get its admin alerts.
--
-- * sales_user_companies gets a role ('sales' default: existing rows unchanged, or 'admin').
-- * private.sales_member(user, company) now means "works here as a visitor", as Sales or Admin, so everything
--   that already uses it (current_company_id, set_active_company, the switcher, profiles_select, company_guard,
--   list_lead_staff, lead_company, Facebook routing) takes visiting admins without being re-created.
-- * my_roles / app_role (from 4200): a visitor whose row says admin is Admin there, otherwise Sales as before.
-- * my_context (from 4200) adds visiting_role; my_session (5200) calls it.
-- * enqueue_for_company (from 0200): admin alerts also reach visiting admins, with the company name.
-- * set_sales_user_companies (from 4200) only touches Sales rows, so the app before this change can't
--   remove an admin's access. New: super_list_team_access, set_user_company_access.
-- Access is re-read on every call: taking away the home admin role, deactivating the user, unticking the
-- company or archiving either company ends it at once. Client CRMs are not offered, as for Sales.
-- Later changes to these functions start from this file.
-- ---------------------------------------------------------------------------

alter table public.sales_user_companies
  add column role public.app_role not null default 'sales';
alter table public.sales_user_companies
  add constraint sales_user_companies_role_check check (role in ('sales', 'admin'));

-- Whether p_user, an active user of another active company of ours, also works in p_company, with the role
-- their row gives (which they must also hold at home). Never calls current_company_id() (which uses it).
create or replace function private.sales_member(p_user uuid, p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.sales_user_companies s
    join public.companies c on c.id = s.company_id and c.archived_at is null and c.parent_company_id is null
    join public.profiles p on p.id = s.user_id and p.is_active and p.company_id is distinct from c.id
      and (case s.role
        when 'admin' then p.role = 'admin' or 'admin' = any(p.extra_roles)
        else p.role = 'sales' or 'sales' = any(p.extra_roles) end)
    join public.companies h on h.id = p.company_id and h.archived_at is null
    where s.user_id = p_user and s.company_id = p_company
  )
$$;

-- Whether p_user works in p_company as a visiting Admin (sales_member with an admin row).
create function private.admin_member(p_user uuid, p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.sales_member(p_user, p_company) and exists (
    select 1 from public.sales_user_companies s where s.user_id = p_user and s.company_id = p_company and s.role = 'admin')
$$;

-- From 4200. In another of our companies a visitor is Admin when their row says so, else Sales only.
create or replace function private.my_roles()
returns public.app_role[]
language sql stable security definer set search_path = ''
as $$
  select case
    when w.parent_company_id is not null and p.company_id is distinct from w.id then array['admin']::public.app_role[]
    when p.role not in ('super_admin', 'ads_manager') and p.company_id is distinct from w.id then
      case when private.admin_member(p.id, w.id) then array['admin']::public.app_role[] else array['sales']::public.app_role[] end
    else array[case when p.role = 'super_admin' then 'admin'::public.app_role else p.role end] || p.extra_roles end
  from public.profiles p
  join public.companies w on w.id = private.current_company_id()
  where p.id = (select auth.uid()) and p.is_active
$$;

create or replace function private.app_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select case
    when p.role = 'super_admin' then 'admin'::public.app_role
    -- In another of our companies (sales_member): Admin when their row says so, else Sales, whatever they are at home.
    when w.parent_company_id is null and p.role <> 'ads_manager' and p.company_id is distinct from w.id then
      case when private.admin_member(p.id, w.id) then 'admin'::public.app_role else 'sales'::public.app_role end
    when p.role = 'admin' or 'admin' = any(p.extra_roles) then 'admin'::public.app_role
    when w.parent_company_id is not null and p.company_id is distinct from w.id then 'admin'::public.app_role
    when p.role = 'sales' or 'sales' = any(p.extra_roles) then 'sales'::public.app_role
    else p.role end
  from public.profiles p
  join public.companies w on w.id = private.current_company_id()
  where p.id = (select auth.uid()) and p.is_active
$$;

-- From 4200, plus visiting_role.
create or replace function public.my_context()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'company_id', w.id,
    'roles', to_jsonb(private.my_roles()),
    -- Working in another of our companies (sales_user_companies), as Sales or Admin.
    'visiting', p.role not in ('super_admin', 'ads_manager') and w.parent_company_id is null and p.company_id is distinct from w.id,
    'visiting_role', case when p.role not in ('super_admin', 'ads_manager') and w.parent_company_id is null and p.company_id is distinct from w.id
      then case when private.admin_member(p.id, w.id) then 'admin' else 'sales' end end,
    'workspace', case when w.parent_company_id is not null then jsonb_build_object(
      'parent_id', a.id, 'parent_name', a.name, 'member', p.company_id is not distinct from w.id,
      'ads_client_id', (select x.id from public.ads_clients x where x.workspace_company_id = w.id)) end)
  from public.profiles p
  join public.companies w on w.id = private.current_company_id()
  left join public.companies a on a.id = w.parent_company_id
  where p.id = (select auth.uid()) and p.is_active
$$;

-- From 0200. Admin alerts also reach admins of other companies who work here (with the company's name,
-- like the super admin's).
create or replace function private.enqueue_for_company(
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
    select p.id, p.role, p.company_id from public.profiles p
    where p.is_active and (
      (p.company_id = p_company_id and (p.role = any(p_roles) or p.extra_roles && p_roles))
      or (p.role = 'super_admin' and 'admin' = any(p_roles))
      or ('admin' = any(p_roles) and p.company_id is distinct from p_company_id and private.admin_member(p.id, p_company_id))
    )
  loop
    if private.enqueue_notification(r.id, p_kind,
         case when r.role = 'super_admin' or r.company_id is distinct from p_company_id
           then p_payload || jsonb_build_object('company', v_company, 'company_id', p_company_id) else p_payload end,
         p_dedupe, p_actor, p_lead_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- From 4200. Only Sales rows: the earlier app's Sales team tab must not remove an admin's access.
create or replace function public.set_sales_user_companies(p_user_id uuid, p_company_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_home uuid;
  v_ids uuid[] := coalesce(p_company_ids, '{}');
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select p.company_id into v_home from public.profiles p
  where p.id = p_user_id and (p.role = 'sales' or 'sales' = any(p.extra_roles));
  if v_home is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if cardinality(v_ids) > 50 or exists (select 1 from unnest(v_ids) x where x = v_home or not exists (
    select 1 from public.companies c where c.id = x and c.archived_at is null and c.parent_company_id is null)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.meta_lead_routing r
  where r.user_id = p_user_id and r.company_id <> v_home and not (r.company_id = any(v_ids))
    and not exists (select 1 from public.sales_user_companies s where s.user_id = p_user_id and s.company_id = r.company_id and s.role = 'admin')
    and exists (select 1 from public.companies c where c.id = r.company_id and c.parent_company_id is null);
  delete from public.sales_user_companies s where s.user_id = p_user_id and s.role = 'sales' and not (s.company_id = any(v_ids));
  insert into public.sales_user_companies (user_id, company_id)
  select p_user_id, x from unnest(v_ids) x
  on conflict do nothing;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'sales_user_companies', jsonb_build_object('company_ids', to_jsonb(v_ids)));
end $$;

-- ---------------------------------------------------------------------------
-- Super admin: who works where, as what
-- ---------------------------------------------------------------------------
create function public.super_list_team_access()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'display_name', p.display_name, 'username', p.username,
      'company_id', c.id, 'company_name', c.name,
      'can_sales', p.role = 'sales' or 'sales' = any(p.extra_roles),
      'can_admin', p.role = 'admin' or 'admin' = any(p.extra_roles),
      'access', coalesce((select jsonb_agg(jsonb_build_object('company_id', s.company_id, 'role', s.role) order by x.created_at, x.id)
        from public.sales_user_companies s join public.companies x on x.id = s.company_id and x.archived_at is null
        where s.user_id = p.id), '[]'::jsonb)
    ) order by c.created_at, c.id, (p.role = 'admin' or 'admin' = any(p.extra_roles)) desc, lower(p.display_name), p.id), '[]'::jsonb)
    from public.profiles p
    join public.companies c on c.id = p.company_id and c.archived_at is null and c.parent_company_id is null
    where p.is_active and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[])
  );
end $$;

-- Replaces the user's other companies: p_access = [{ "company_id": uuid, "role": "sales" | "admin" }].
-- A role must be one they hold at home. Leaving a company also takes them out of its lead routing.
create function public.set_user_company_access(p_user_id uuid, p_access jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_ids uuid[];
  v_bad boolean;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_profile from public.profiles p
  where p.id = p_user_id and p.role not in ('super_admin', 'ads_manager', 'client')
    and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]);
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_access is null or jsonb_typeof(p_access) <> 'array' or jsonb_array_length(p_access) > 50 then
    raise exception 'invalid_access' using errcode = '22023';
  end if;

  select
    coalesce(array_agg((e ->> 'company_id')::uuid), '{}'),
    coalesce(bool_or(
      jsonb_typeof(e) <> 'object'
      or e ->> 'company_id' is null
      or e ->> 'role' is null or e ->> 'role' not in ('sales', 'admin')
      or (e ->> 'role' = 'admin' and not (v_profile.role = 'admin' or 'admin' = any(v_profile.extra_roles)))
      or (e ->> 'role' = 'sales' and not (v_profile.role = 'sales' or 'sales' = any(v_profile.extra_roles)))
    ), false)
  into v_ids, v_bad
  from jsonb_array_elements(p_access) e;
  if v_bad or cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x) then
    raise exception 'invalid_access' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_ids) x where x = v_profile.company_id or not exists (
    select 1 from public.companies c where c.id = x and c.archived_at is null and c.parent_company_id is null)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  delete from public.meta_lead_routing r
  where r.user_id = p_user_id and r.company_id <> v_profile.company_id and not (r.company_id = any(v_ids))
    and exists (select 1 from public.companies c where c.id = r.company_id and c.parent_company_id is null);
  delete from public.sales_user_companies s where s.user_id = p_user_id and not (s.company_id = any(v_ids));
  insert into public.sales_user_companies (user_id, company_id, role)
  select p_user_id, (e ->> 'company_id')::uuid, (e ->> 'role')::public.app_role from jsonb_array_elements(p_access) e
  on conflict (user_id, company_id) do update set role = excluded.role;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'user_company_access', jsonb_build_object('access', p_access));
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.admin_member(uuid, uuid),
  public.super_list_team_access(),
  public.set_user_company_access(uuid, jsonb)
from public, anon, authenticated;

grant execute on function private.admin_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.super_list_team_access(), public.set_user_company_access(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
