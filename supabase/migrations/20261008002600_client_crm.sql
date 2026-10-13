-- ---------------------------------------------------------------------------
-- Client CRMs. Each ads client can get its own CRM: a workspace company (companies.parent_company_id
-- = the agency) linked from ads_clients.workspace_company_id. Leads, follow-ups, timeline, pipeline,
-- niches, dashboards, reminders and the Facebook Lead Ads connection are all scoped to the current
-- company, so a workspace reuses them unchanged.
--
-- * Who enters: the super admin, admins of the agency, and ads managers assigned to the agency
--   (private.workspace_staff). They switch in with set_active_company and act as Admin there.
-- * The client's own staff are ordinary users of the workspace (company_id = workspace) with their
--   own role; they can't switch anywhere.
-- * Workspaces have features {client_workspace, no_ads}: no Ads or Automation inside, and they stay
--   out of agency-wide company lists.
-- ---------------------------------------------------------------------------

alter table public.companies add column parent_company_id uuid references public.companies (id);
alter table public.companies add constraint companies_parent_check check (parent_company_id is distinct from id);
create index companies_parent_idx on public.companies (parent_company_id) where parent_company_id is not null;
alter table public.ads_clients add column workspace_company_id uuid unique references public.companies (id);

alter table public.companies drop constraint companies_features_check;
alter table public.companies add constraint companies_features_check
  check (features <@ array['projects', 'no_ads', 'client_workspace']::text[]);

-- ---------------------------------------------------------------------------
-- Entering a client CRM
-- ---------------------------------------------------------------------------
-- Whether p_user is agency staff who may work in client CRM p_company. Never calls
-- current_company_id() (which uses it).
create function private.workspace_staff(p_user uuid, p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.companies w
    join public.companies a on a.id = w.parent_company_id and a.archived_at is null
    join public.profiles p on p.id = p_user and p.is_active
    where w.id = p_company and w.archived_at is null
      and (p.role = 'super_admin'
        or (p.company_id = a.id and (p.role = 'admin' or 'admin' = any(p.extra_roles)))
        or (p.role = 'ads_manager' and exists (
          select 1 from public.ads_manager_companies m where m.user_id = p.id and m.company_id = a.id)))
  )
$$;

create function private.is_workspace(p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.companies c where c.id = p_company and c.parent_company_id is not null) $$;

create function private.can_enter_workspace(p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select private.workspace_staff((select auth.uid()), p_company) $$;

-- As before, plus: agency staff whose chosen company is a client CRM they may enter work there.
create or replace function private.current_company_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select case
    when p.role = 'super_admin' then coalesce(
      (select c.id from public.companies c where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1))
    when p.active_company_id is not null and p.active_company_id is distinct from p.company_id
         and private.workspace_staff(p.id, p.active_company_id) then p.active_company_id
    when p.role = 'ads_manager' then coalesce(
      (select c.id from public.companies c join public.ads_manager_companies a on a.company_id = c.id and a.user_id = p.id
        where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c join public.ads_manager_companies a on a.company_id = c.id and a.user_id = p.id
        where c.archived_at is null order by c.created_at, c.id limit 1))
    else (select c.id from public.companies c where c.id = p.company_id and c.archived_at is null) end
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

-- Agency staff inside a client CRM (they are not its members) act as Admin there.
create or replace function private.my_roles()
returns public.app_role[]
language sql stable security definer set search_path = ''
as $$
  select case
    when w.parent_company_id is not null and p.company_id is distinct from w.id then array['admin']::public.app_role[]
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
    when p.role in ('super_admin', 'admin') or 'admin' = any(p.extra_roles) then 'admin'::public.app_role
    when w.parent_company_id is not null and p.company_id is distinct from w.id then 'admin'::public.app_role
    when p.role = 'sales' or 'sales' = any(p.extra_roles) then 'sales'::public.app_role
    else p.role end
  from public.profiles p
  join public.companies w on w.id = private.current_company_id()
  where p.id = (select auth.uid()) and p.is_active
$$;

-- Super admin: any company. Ads manager: an assigned company. Agency staff: a client CRM they may
-- enter. Everyone: back to their own company.
create or replace function public.set_active_company(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (private.is_super_admin() or p_company_id = any(private.ads_manager_company_ids())
          or private.can_enter_workspace(p_company_id)
          or exists (select 1 from public.profiles p where p.id = (select auth.uid())
                     and p.role not in ('super_admin', 'ads_manager') and p.company_id = p_company_id)) then
    perform private.raise_forbidden();
  end if;
  update public.profiles set active_company_id = p_company_id where id = (select auth.uid());
end $$;

-- What the app needs about where the user is working right now.
create function public.my_context()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'company_id', w.id,
    'roles', to_jsonb(private.my_roles()),
    'workspace', case when w.parent_company_id is not null then jsonb_build_object(
      'parent_id', a.id, 'parent_name', a.name, 'member', p.company_id is not distinct from w.id,
      'ads_client_id', (select x.id from public.ads_clients x where x.workspace_company_id = w.id)) end)
  from public.profiles p
  join public.companies w on w.id = private.current_company_id()
  left join public.companies a on a.id = w.parent_company_id
  where p.id = (select auth.uid()) and p.is_active
$$;

drop policy companies_select on public.companies;
create policy companies_select on public.companies for select to authenticated
  using (
    (select private.is_super_admin())
    or id = (select private.current_company_id())
    or id = any((select private.ads_manager_company_ids())::uuid[])
    or private.can_enter_workspace(id)
  );

-- Inside a client CRM, our staff who can work there are visible too (owners, pickers, timeline).
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.app_role()) is not null and (select private.app_role()) <> 'client'
        and (company_id = (select private.current_company_id()) or role = 'super_admin'
          or ((select private.is_workspace(private.current_company_id()))
              and private.workspace_staff(id, (select private.current_company_id())))))
    or ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]))
  );

-- Unchanged except that our staff may own leads inside a client CRM they can enter.
create or replace function private.company_guard()
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
    -- Finance entries may move to another company of the same books; everything else keeps its company.
    if tg_table_name not in ('capital_entries', 'expenses') then
      new.company_id := old.company_id;
    elsif v_uid is not null and not private.is_super_admin()
          and not (old.company_id = any(private.finance_company_ids())) then
      perform private.raise_forbidden();
    end if;
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

  if v_uid is not null and not private.is_super_admin() and not (
    case when tg_table_name in ('capital_entries', 'expenses', 'expense_recurrences', 'finance_activities')
      then coalesce(v_row.company_id = any(private.finance_company_ids()), false)
      else v_row.company_id is not distinct from private.current_company_id() end
  ) then
    perform private.raise_forbidden();
  end if;

  if tg_op <> 'DELETE' and tg_table_name = 'leads' then
    if (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) and not exists (
      select 1 from public.profiles p
      where p.id = new.owner_id and (p.company_id = new.company_id or p.role = 'super_admin'
        -- Our staff may own leads in a client CRM they can enter.
        or private.workspace_staff(p.id, new.company_id))
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

create or replace function private.assert_valid_owner(p_owner_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = p_owner_id and p.is_active
      -- Ads managers only pass company_guard inside client CRMs they can enter.
      and (p.role in ('sales', 'admin', 'super_admin', 'ads_manager') or p.extra_roles && array['sales', 'admin']::public.app_role[])
  ) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Creating a client's CRM and its summary for the ads team
-- ---------------------------------------------------------------------------
-- Idempotent. The company name is unique across the CRM, so a clash gets " (client)", " (client 2)" ...
create function public.open_ads_client_crm(p_client uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.require_ads_client(p_client);
  v_client public.ads_clients%rowtype;
  v_base text;
  v_name text;
  v_n integer := 1;
  v_id uuid;
begin
  if not (private.is_super_admin() or private.workspace_staff_for_agency(v_company)) then
    perform private.raise_forbidden();
  end if;
  select * into v_client from public.ads_clients c where c.id = p_client for update;
  if v_client.workspace_company_id is not null then
    return v_client.workspace_company_id;
  end if;
  v_base := left(coalesce(private.clean_label(v_client.company_name), private.clean_label(v_client.name)), 64);
  v_name := v_base;
  while exists (select 1 from public.companies c where c.normalized_name = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'))) loop
    v_name := v_base || case when v_n = 1 then ' (client)' else ' (client ' || v_n || ')' end;
    v_n := v_n + 1;
  end loop;
  insert into public.companies (name, parent_company_id, features, created_by)
  values (v_name, v_company, array['client_workspace', 'no_ads'], (select auth.uid()))
  returning id into v_id;
  update public.ads_clients set workspace_company_id = v_id where id = p_client;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_crm_created', jsonb_build_object('ads_client_id', p_client, 'company_id', v_id, 'name', v_name));
  return v_id;
end $$;

-- Whether the caller is agency staff of p_agency (admin there, or an ads manager assigned to it).
create function private.workspace_staff_for_agency(p_agency uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.is_active
      and (p.role = 'super_admin'
        or (p.company_id = p_agency and (p.role = 'admin' or 'admin' = any(p.extra_roles)))
        or (p.role = 'ads_manager' and exists (
          select 1 from public.ads_manager_companies m where m.user_id = p.id and m.company_id = p_agency)))
  )
$$;

-- Counts for the client page's Leads tab (null until the CRM exists).
create function public.ads_client_crm_summary(p_client uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws uuid;
  v_today date := private.ist_today();
  v_day_start timestamptz := v_today::timestamp at time zone 'Asia/Kolkata';
  v_month_start timestamptz := date_trunc('month', v_today)::timestamp at time zone 'Asia/Kolkata';
begin
  perform private.require_ads_client(p_client);
  select c.workspace_company_id into v_ws from public.ads_clients c where c.id = p_client;
  if v_ws is null then
    return null;
  end if;
  return (
    select jsonb_build_object(
      'company_id', w.id, 'name', w.name, 'archived', w.archived_at is not null,
      'active_leads', (select count(*) from public.leads l where l.company_id = w.id and l.archived_at is null and l.status not in ('won', 'lost')),
      'new_today', (select count(*) from public.leads l where l.company_id = w.id and l.created_at >= v_day_start),
      'won_this_month', (select count(distinct a.lead_id) from public.lead_activities a join public.leads l on l.id = a.lead_id
        where l.company_id = w.id and a.type = 'status_changed' and a.meta ->> 'to_kind' = 'won' and a.created_at >= v_month_start),
      'due_today', (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id
        where l.company_id = w.id and l.archived_at is null and f.state = 'pending' and f.due_at >= now() and f.due_at < v_day_start + interval '1 day'),
      'overdue', (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id
        where l.company_id = w.id and l.archived_at is null and f.state = 'pending' and f.due_at < now()),
      'users', (select count(*) from public.profiles p where p.company_id = w.id and p.is_active),
      'facebook', (select m.status from public.meta_integrations m where m.company_id = w.id))
    from public.companies w where w.id = v_ws
  );
end $$;

-- The company a lead is in, when the caller could work there (so a link from Telegram or another
-- tab can switch to it): any company for the super admin, an assigned one for an ads manager, a
-- client CRM they may enter, or their own company. Null otherwise.
create function public.lead_company(p_lead_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'brand_highlight', c.brand_highlight, 'logo_path', c.logo_path)
  from public.leads l
  join public.companies c on c.id = l.company_id and c.archived_at is null
  join public.profiles p on p.id = (select auth.uid()) and p.is_active
  where l.id = p_lead_id
    and (p.role = 'super_admin' or c.id = any(private.ads_manager_company_ids())
      or private.workspace_staff(p.id, c.id) or p.company_id = c.id)
$$;

-- ---------------------------------------------------------------------------
-- Client CRMs stay out of the super admin's company lists (Super settings, Ads, Automation, books)
-- ---------------------------------------------------------------------------
create or replace function public.super_list_companies()
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
      'created_at', c.created_at, 'archived_at', c.archived_at, 'features', to_jsonb(c.features),
      'users', (select count(*) from public.profiles p where p.company_id = c.id and p.is_active),
      'admins', (select count(*) from public.profiles p where p.company_id = c.id and p.is_active
                 and (p.role = 'admin' or 'admin' = any(p.extra_roles))),
      'leads', (select count(*) from public.leads l where l.company_id = c.id and l.archived_at is null)
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c
    where c.parent_company_id is null
  );
end $$;

create or replace function public.super_ads_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', c.id, 'company_name', c.name, 'won_to_ads_client', c.won_to_ads_client,
      'account', (select private.ad_account_json(a, 'all') from public.ad_accounts a
        where a.company_id = c.id and a.kind = 'company' and a.archived_at is null),
      'members', coalesce((select jsonb_agg(m.company_id) from public.ad_account_members m
        join public.ad_accounts a on a.id = m.ad_account_id and a.company_id = c.id and a.kind = 'company' and a.archived_at is null), '[]'::jsonb),
      'member_of', (select a.company_id from public.ad_account_members m join public.ad_accounts a on a.id = m.ad_account_id
        where m.company_id = c.id and a.archived_at is null limit 1)
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c where c.archived_at is null and c.parent_company_id is null
  );
end $$;

create or replace function public.super_meta_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.is_super_admin() or private.app_role() = 'admin') then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', c.id, 'company_name', c.name,
      'integration', (select jsonb_build_object('app_id', m.app_id, 'page_id', m.page_id, 'page_name', m.page_name,
          'verify_token', m.verify_token, 'status', m.status, 'last_checked_at', m.last_checked_at,
          'last_event_at', m.last_event_at, 'last_error', m.last_error)
        from public.meta_integrations m where m.company_id = c.id),
      'routing', coalesce((select jsonb_agg(r.user_id) from public.meta_lead_routing r where r.company_id = c.id), '[]'::jsonb),
      'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role) order by p.role desc, lower(p.display_name))
        from public.profiles p where p.company_id = c.id and p.is_active and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[])), '[]'::jsonb),
      'leads_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'created' and e.created_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'failed' and e.created_at > now() - interval '7 days')
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c
    where c.archived_at is null and c.parent_company_id is null and private.can_manage_meta(c.id)
  );
end $$;

create or replace function public.super_finance_groups()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'companies', (
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'can_edit', c.finance_can_edit) order by c.created_at, c.id)
      from public.companies c where c.finance_group_id = g.id and c.archived_at is null and c.parent_company_id is null)) order by g.created_at, g.id), '[]'::jsonb)
    from public.finance_groups g
    where exists (select 1 from public.companies c where c.finance_group_id = g.id and c.archived_at is null and c.parent_company_id is null)
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.is_workspace(uuid),
  private.workspace_staff(uuid, uuid),
  private.can_enter_workspace(uuid),
  private.workspace_staff_for_agency(uuid),
  public.my_context(),
  public.lead_company(uuid),
  public.open_ads_client_crm(uuid),
  public.ads_client_crm_summary(uuid)
from public, anon, authenticated;

grant execute on function private.is_workspace(uuid), private.can_enter_workspace(uuid), private.workspace_staff(uuid, uuid) to authenticated, service_role;
grant execute on function public.my_context(), public.lead_company(uuid), public.open_ads_client_crm(uuid), public.ads_client_crm_summary(uuid) to authenticated;
