-- Ads team access.
--
-- * ads_manager: no home company. The super admin assigns the companies they handle
--   (ads_manager_companies); they switch between those like the super admin switches companies.
--   private.app_role() reports 'ads_manager', so every lead, finance and user helper denies them.
-- * client: a read-only portal login for one ads client (profiles.ads_client_id). It belongs to the
--   agency company but sees only its own profile and its own ad account.
-- * ads_clients: won leads handed to the ads team (created in a later migration's trigger).

alter table public.companies add column won_to_ads_client boolean not null default false;
update public.companies set won_to_ads_client = true where normalized_name = 'star growth hub';

create table public.ads_clients (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  lead_id uuid unique references public.leads (id) on delete set null,
  name text not null check (char_length(name) between 1 and 120),
  phone text check (phone is null or char_length(phone) <= 32),
  email text check (email is null or char_length(email) <= 254),
  business text check (business is null or char_length(business) <= 120),
  status text not null default 'onboarding' check (status in ('onboarding', 'active', 'paused', 'closed')),
  notes text check (notes is null or char_length(notes) <= 2000),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ads_clients_company_idx on public.ads_clients (company_id, status, created_at desc, id desc);
create trigger ads_clients_touch before update on public.ads_clients
  for each row execute function private.touch_updated_at();

create table public.ads_manager_companies (
  user_id uuid not null references public.profiles (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);
create index ads_manager_companies_company_idx on public.ads_manager_companies (company_id);

alter table public.profiles add column ads_client_id uuid references public.ads_clients (id);

alter table public.profiles drop constraint profiles_company_check;
alter table public.profiles add constraint profiles_company_check check (
  ((role in ('super_admin', 'ads_manager')) = (company_id is null))
  and ((role = 'client') = (ads_client_id is not null))
);

alter table public.ads_clients enable row level security;
alter table public.ads_manager_companies enable row level security;
revoke all on public.ads_clients, public.ads_manager_companies from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- The active (non-archived) companies assigned to the signed-in ads manager.
create function private.ads_manager_company_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(a.company_id order by c.created_at, c.id), '{}')
  from public.ads_manager_companies a
  join public.companies c on c.id = a.company_id and c.archived_at is null
  join public.profiles p on p.id = a.user_id and p.is_active and p.role = 'ads_manager'
  where a.user_id = (select auth.uid())
$$;

-- Ads managers work in their chosen assigned company. The assignment is re-read on every call,
-- so removing a company takes effect immediately even while it is their active company.
create or replace function private.current_company_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select case
    when p.role = 'super_admin' then coalesce(
      (select c.id from public.companies c where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1))
    when p.role = 'ads_manager' then coalesce(
      (select c.id from public.companies c join public.ads_manager_companies a on a.company_id = c.id and a.user_id = p.id
        where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c join public.ads_manager_companies a on a.company_id = c.id and a.user_id = p.id
        where c.archived_at is null order by c.created_at, c.id limit 1))
    else (select c.id from public.companies c where c.id = p.company_id and c.archived_at is null) end
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create function private.is_ads_user()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.app_role() in ('admin', 'ads_manager'), false) $$;

-- The ads client a client login belongs to (null for everyone else).
create function private.my_ads_client_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select p.ads_client_id from public.profiles p
  join public.ads_clients c on c.id = p.ads_client_id
  where p.id = (select auth.uid()) and p.is_active and p.role = 'client'
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: clients see only themselves; ads managers see their assigned companies
-- ---------------------------------------------------------------------------
drop policy companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
  using (
    (select private.is_super_admin())
    or id = (select private.current_company_id())
    or id = any((select private.ads_manager_company_ids())::uuid[])
  );

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.app_role()) in ('admin', 'sales', 'account', 'ads_manager')
        and (company_id = (select private.current_company_id()) or role = 'super_admin'))
    or ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]))
  );

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role;
  v_company uuid;
  v_client uuid;
begin
  if new.raw_app_meta_data ? 'crm_role'
     and not exists (select 1 from public.profiles p where p.id = new.id) then
    v_role := (new.raw_app_meta_data ->> 'crm_role')::public.app_role;
    if v_role not in ('super_admin', 'ads_manager') then
      v_company := nullif(new.raw_app_meta_data ->> 'crm_company_id', '')::uuid;
      if v_company is null or not exists (select 1 from public.companies c where c.id = v_company and c.archived_at is null) then
        raise exception 'company_required' using errcode = '23514';
      end if;
    end if;
    if v_role = 'client' then
      v_client := nullif(new.raw_app_meta_data ->> 'crm_ads_client_id', '')::uuid;
      if v_client is null or not exists (select 1 from public.ads_clients c where c.id = v_client and c.company_id = v_company) then
        raise exception 'ads_client_required' using errcode = '23514';
      end if;
    end if;
    insert into public.profiles (id, username, display_name, role, company_id, active_company_id, ads_client_id)
    values (
      new.id,
      new.raw_app_meta_data ->> 'crm_username',
      btrim(new.raw_app_meta_data ->> 'crm_display_name'),
      v_role,
      v_company,
      case when v_role = 'super_admin'
        then (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1) end,
      v_client
    );
    insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
    values (
      (select p.id from public.profiles p
        where p.id = nullif(new.raw_app_meta_data ->> 'crm_created_by', '')::uuid),
      new.id,
      'user_created',
      jsonb_strip_nulls(jsonb_build_object('role', v_role, 'company_id', v_company, 'ads_client_id', v_client))
    );
  end if;
  return new;
end $$;

-- Company admins manage the company's staff only: never super admins, ads managers or client logins.
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
  if p_role in ('super_admin', 'ads_manager', 'client') then
    perform private.raise_forbidden();
  end if;

  -- Serialize admin changes so two concurrent demotions cannot remove a company's last admin.
  perform 1 from public.profiles where company_id = v_company and role = 'admin' and is_active for update;

  select * into v_old from public.profiles where id = p_user_id for update;
  if not found or v_old.company_id is distinct from v_company or v_old.role = 'client' then
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
      and p.role <> 'client'
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

-- Also the authorization check before the server resets the Auth password (company staff only).
create or replace function public.admin_log_password_reset(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() or not exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.company_id = private.current_company_id() and p.role <> 'client'
  ) then
    perform private.raise_forbidden();
  end if;
  insert into public.admin_audit_log (actor_id, target_user_id, action)
  values ((select auth.uid()), p_user_id, 'password_reset');
end $$;

-- Super admin: any company. Ads manager: one of their assigned companies.
create or replace function public.set_active_company(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (private.is_super_admin() or p_company_id = any(private.ads_manager_company_ids())) then
    perform private.raise_forbidden();
  end if;
  update public.profiles set active_company_id = p_company_id where id = (select auth.uid());
end $$;

-- ---------------------------------------------------------------------------
-- Ads managers (super admin)
-- ---------------------------------------------------------------------------
create function public.super_list_ads_managers()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'username', p.username, 'display_name', p.display_name, 'is_active', p.is_active, 'created_at', p.created_at,
      'company_ids', coalesce((select jsonb_agg(a.company_id order by c.created_at) from public.ads_manager_companies a
        join public.companies c on c.id = a.company_id where a.user_id = p.id), '[]'::jsonb)
    ) order by p.is_active desc, lower(p.display_name), p.id), '[]'::jsonb)
    from public.profiles p where p.role = 'ads_manager'
  );
end $$;

create function public.set_ads_manager_companies(p_user_id uuid, p_company_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.role = 'ads_manager') then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_company_ids, '{}')) x
             where not exists (select 1 from public.companies c where c.id = x and c.archived_at is null)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.ads_manager_companies a where a.user_id = p_user_id and not (a.company_id = any(coalesce(p_company_ids, '{}')));
  insert into public.ads_manager_companies (user_id, company_id)
  select p_user_id, x from unnest(coalesce(p_company_ids, '{}')) x
  on conflict do nothing;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'ads_manager_companies', jsonb_build_object('company_ids', to_jsonb(coalesce(p_company_ids, '{}'))));
end $$;

-- Also the authorization check before the server resets an ads manager's Auth password.
create function public.super_update_ads_manager(p_user_id uuid, p_display_name text default null, p_is_active boolean default null, p_password_reset boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  update public.profiles set
    display_name = coalesce(private.clean_label(p_display_name), display_name),
    is_active = coalesce(p_is_active, is_active)
  where id = p_user_id and role = 'ads_manager';
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, case when p_password_reset then 'password_reset' else 'user_updated' end,
    jsonb_strip_nulls(jsonb_build_object('display_name', p_display_name, 'is_active', p_is_active)));
end $$;

-- ---------------------------------------------------------------------------
-- Notifications: new ads clients and ad account problems
-- ---------------------------------------------------------------------------
alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check check (kind in (
  'recurring_expense', 'lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
  'expense_added', 'capital_added', 'library_file_added', 'digest_sales', 'digest_admin', 'digest_finance', 'test',
  'ads_client_new', 'ad_account_problem'));

create or replace function private.notification_kinds_for(p_role public.app_role)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_role
    when 'admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'ads_client_new', 'ad_account_problem', 'test']
    when 'super_admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'ads_client_new', 'ad_account_problem', 'test']
    when 'sales' then array['lead_assigned', 'follow_up_changed', 'overdue_nag', 'library_file_added', 'digest_sales', 'test']
    when 'account' then array['expense_added', 'capital_added', 'recurring_expense', 'digest_finance', 'test']
    when 'ads_manager' then array['ads_client_new', 'ad_account_problem', 'test']
    else array[]::text[] end
$$;

-- The company's admins (and the super admin) plus the ads managers assigned to it.
create function private.enqueue_for_ads_team(p_company_id uuid, p_kind text, p_payload jsonb, p_dedupe text, p_actor uuid default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
  v_company text := (select c.name from public.companies c where c.id = p_company_id);
  r record;
begin
  v_count := private.enqueue_for_company(p_company_id, array['admin']::public.app_role[], p_kind, p_payload, p_dedupe, p_actor);
  for r in
    select p.id from public.profiles p
    join public.ads_manager_companies a on a.user_id = p.id and a.company_id = p_company_id
    where p.is_active and p.role = 'ads_manager'
  loop
    if private.enqueue_notification(r.id, p_kind, p_payload || jsonb_build_object('company', v_company, 'company_id', p_company_id), p_dedupe, p_actor) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.ads_manager_company_ids(),
  private.is_ads_user(),
  private.my_ads_client_id(),
  private.enqueue_for_ads_team(uuid, text, jsonb, text, uuid),
  public.super_list_ads_managers(),
  public.set_ads_manager_companies(uuid, uuid[]),
  public.super_update_ads_manager(uuid, text, boolean, boolean)
from public, anon, authenticated;

grant execute on function private.ads_manager_company_ids(), private.is_ads_user(), private.my_ads_client_id() to authenticated, service_role;
grant execute on function
  public.super_list_ads_managers(),
  public.set_ads_manager_companies(uuid, uuid[]),
  public.super_update_ads_manager(uuid, text, boolean, boolean)
to authenticated;
