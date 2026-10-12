-- ---------------------------------------------------------------------------
-- Many roles per person + per-company features (Star Gardens "projects").
--
-- * profiles.role stays the person's main role; profiles.extra_roles adds more
--   ("Also works as"). Permissions are the union of all of them.
-- * private.app_role() keeps returning ONE role for older code, chosen by
--   precedence: admin, then sales, then the main role. So lead scope rules
--   ("admin sees all, sales sees own") keep working unchanged.
-- * Checks for any other role use private.has_role(), which reads every role.
-- * companies.features switches optional modules on per company. 'projects'
--   (the Star Gardens project flow) is switched on for the company named
--   "Star Gardens"; the super admin can switch it for any company.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Company features
-- ---------------------------------------------------------------------------
alter table public.companies add column features text[] not null default '{}';
alter table public.companies add constraint companies_features_check check (features <@ array['projects']::text[]);

create function private.company_has(p_feature text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((
    select p_feature = any(c.features) from public.companies c
    where c.id = private.current_company_id() and c.archived_at is null), false)
$$;

create function private.is_project_role(p_role public.app_role)
returns boolean
language sql immutable set search_path = ''
as $$ select p_role in ('architect_manager', 'landscape_designer', 'execution') $$;

-- Lead stages follow the Star Gardens sales process, but only while the company still has the
-- untouched default stages (an admin's own setup is never overwritten).
create function private.apply_projects_pipeline(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if (select array_agg(s.name order by s.position, s.id) from public.pipeline_stages s
      where s.company_id = p_company_id and s.archived_at is null)
     = array['New', 'Contacted', 'Interested', 'Proposal sent', 'Won', 'Lost'] then
    update public.pipeline_stages s set name = case s.name
        when 'New' then 'Inquiry' when 'Contacted' then 'Pitch' when 'Interested' then 'Negotiation'
        when 'Proposal sent' then 'On hold' when 'Won' then 'Closed' else s.name end,
      color = case s.name when 'Proposal sent' then 'slate' when 'New' then 'blue' when 'Contacted' then 'violet'
        when 'Interested' then 'amber' else s.color end
    where s.company_id = p_company_id and s.archived_at is null;
  end if;
end $$;

-- Super admin only.
create function public.set_company_feature(p_company_id uuid, p_feature text, p_enabled boolean)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_features text[];
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if p_feature is null or p_feature not in ('projects') then
    raise exception 'invalid_feature' using errcode = '22023';
  end if;
  update public.companies c set features = case
      when coalesce(p_enabled, false) then (select array_agg(distinct f order by f) from unnest(c.features || p_feature) f)
      else array_remove(c.features, p_feature) end
  where c.id = p_company_id
  returning c.features into v_features;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_enabled and p_feature = 'projects' then
    perform private.apply_projects_pipeline(p_company_id);
  end if;
  return v_features;
end $$;

update public.companies set features = array['projects'] where normalized_name = 'star gardens';
select private.apply_projects_pipeline(c.id) from public.companies c where 'projects' = any(c.features);

-- ---------------------------------------------------------------------------
-- Extra roles
-- ---------------------------------------------------------------------------
alter table public.profiles add column extra_roles public.app_role[] not null default '{}';
alter table public.profiles add constraint profiles_extra_roles_check check (
  not (extra_roles && array['super_admin', 'ads_manager', 'client']::public.app_role[])
  and not (role = any(extra_roles))
  and cardinality(extra_roles) <= 6
  and (role not in ('super_admin', 'ads_manager', 'client') or cardinality(extra_roles) = 0)
);

-- Every role the signed-in user has in the current company (a super admin is "admin" there).
create function private.my_roles()
returns public.app_role[]
language sql stable security definer set search_path = ''
as $$
  select array[case when p.role = 'super_admin' then 'admin'::public.app_role else p.role end] || p.extra_roles
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active and private.current_company_id() is not null
$$;

create function private.has_role(p_role public.app_role)
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(p_role = any(private.my_roles()), false) $$;

create or replace function private.app_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select case
    when p.role in ('super_admin', 'admin') or 'admin' = any(p.extra_roles) then 'admin'::public.app_role
    when p.role = 'sales' or 'sales' = any(p.extra_roles) then 'sales'::public.app_role
    else p.role end
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active and private.current_company_id() is not null
$$;

create or replace function private.is_finance_user()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.app_role() = 'admin' or private.has_role('account'), false) $$;

-- Staff of the company (not clients) see each other's names.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.app_role()) is not null and (select private.app_role()) <> 'client'
        and (company_id = (select private.current_company_id()) or role = 'super_admin'))
    or ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]))
  );

create or replace function private.assert_valid_owner(p_owner_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = p_owner_id and p.is_active
      and (p.role in ('sales', 'admin', 'super_admin') or p.extra_roles && array['sales', 'admin']::public.app_role[])
  ) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Notifications: a person gets the kinds of every role they have
-- ---------------------------------------------------------------------------
create function private.notification_kinds_for_roles(p_role public.app_role, p_extra public.app_role[])
returns text[]
language sql immutable set search_path = ''
as $$
  select coalesce(array_agg(distinct k order by k), '{}')
  from unnest(array[p_role] || coalesce(p_extra, '{}')) r, unnest(private.notification_kinds_for(r)) k
$$;

create or replace function private.enqueue_notification(
  p_recipient uuid, p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null, p_follow_up_id uuid default null
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  if p_recipient is null or p_recipient = p_actor then
    return false;
  end if;
  insert into public.telegram_notifications (recipient_id, kind, payload, dedupe_key, lead_id, follow_up_id)
  select p.id, p_kind, p_payload, p_dedupe, p_lead_id, p_follow_up_id
  from public.profiles p
  join public.telegram_connections t on t.user_id = p.id and t.status = 'connected'
  left join public.notification_settings s on s.user_id = p.id
  where p.id = p_recipient and p.is_active
    and p_kind = any(private.notification_kinds_for_roles(p.role, p.extra_roles))
    and not (p_kind = any(coalesce(s.disabled_kinds, '{}')))
  on conflict do nothing;
  return found;
end $$;

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
    select p.id, p.role from public.profiles p
    where p.is_active and (
      (p.company_id = p_company_id and (p.role = any(p_roles) or p.extra_roles && p_roles))
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

create or replace function private.enqueue_for_roles(
  p_roles public.app_role[], p_kind text, p_payload jsonb, p_dedupe text,
  p_actor uuid default null, p_lead_id uuid default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in select p.id from public.profiles p where p.is_active and (p.role = any(p_roles) or p.extra_roles && p_roles) loop
    if private.enqueue_notification(r.id, p_kind, p_payload, p_dedupe, p_actor, p_lead_id) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;

create or replace function public.set_notification_pref(p_kind text, p_enabled boolean)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_kinds text[];
  v_disabled text[];
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  select private.notification_kinds_for_roles(p.role, p.extra_roles) into v_kinds
  from public.profiles p where p.id = (select auth.uid());
  if p_kind is null or p_kind = 'test' or not (p_kind = any(v_kinds)) then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  insert into public.notification_settings as s (user_id, disabled_kinds)
  values ((select auth.uid()), case when p_enabled then '{}'::text[] else array[p_kind] end)
  on conflict (user_id) do update set
    disabled_kinds = case when p_enabled then array_remove(s.disabled_kinds, p_kind)
                          when p_kind = any(s.disabled_kinds) then s.disabled_kinds
                          else s.disabled_kinds || p_kind end,
    updated_at = now()
  returning disabled_kinds into v_disabled;
  return v_disabled;
end $$;

-- ---------------------------------------------------------------------------
-- Users: create / update / list with extra roles
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role;
  v_company uuid;
  v_client uuid;
  v_extra public.app_role[];
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
    v_extra := coalesce((
      select array_agg(distinct x::public.app_role order by x::public.app_role)
      from jsonb_array_elements_text(case when jsonb_typeof(new.raw_app_meta_data -> 'crm_extra_roles') = 'array'
        then new.raw_app_meta_data -> 'crm_extra_roles' else '[]'::jsonb end) x
      where x <> v_role::text), '{}');
    if (private.is_project_role(v_role) or exists (select 1 from unnest(v_extra) x where private.is_project_role(x)))
       and not exists (select 1 from public.companies c where c.id = v_company and 'projects' = any(c.features)) then
      raise exception 'feature_disabled' using errcode = '23514';
    end if;
    insert into public.profiles (id, username, display_name, role, extra_roles, company_id, active_company_id, ads_client_id)
    values (
      new.id,
      new.raw_app_meta_data ->> 'crm_username',
      btrim(new.raw_app_meta_data ->> 'crm_display_name'),
      v_role,
      v_extra,
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
      jsonb_strip_nulls(jsonb_build_object('role', v_role, 'extra_roles', case when cardinality(v_extra) > 0 then to_jsonb(v_extra) end,
        'company_id', v_company, 'ads_client_id', v_client))
    );
  end if;
  return new;
end $$;

drop function public.admin_update_user(uuid, text, public.app_role, boolean);
create function public.admin_update_user(
  p_user_id uuid,
  p_display_name text default null,
  p_role public.app_role default null,
  p_is_active boolean default null,
  p_extra_roles public.app_role[] default null
)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.profiles%rowtype;
  v_new public.profiles%rowtype;
  v_company uuid := private.current_company_id();
  v_role public.app_role;
  v_extra public.app_role[];
  v_old_roles public.app_role[];
  v_new_roles public.app_role[];
  v_lead_roles constant public.app_role[] := array['sales', 'admin']::public.app_role[];
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_role in ('super_admin', 'ads_manager', 'client')
     or p_extra_roles && array['super_admin', 'ads_manager', 'client']::public.app_role[] then
    perform private.raise_forbidden();
  end if;

  -- Serialize admin changes so two concurrent demotions cannot remove a company's last admin.
  perform 1 from public.profiles
  where company_id = v_company and (role = 'admin' or 'admin' = any(extra_roles)) and is_active for update;

  select * into v_old from public.profiles where id = p_user_id for update;
  if not found or v_old.company_id is distinct from v_company or v_old.role = 'client' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  v_role := coalesce(p_role, v_old.role);
  v_extra := coalesce((
    select array_agg(distinct x order by x) from unnest(coalesce(p_extra_roles, v_old.extra_roles)) x where x <> v_role), '{}');
  v_old_roles := array[v_old.role] || v_old.extra_roles;
  v_new_roles := array[v_role] || v_extra;

  -- Project roles exist only where the projects module is on (people who already have one keep it).
  if exists (select 1 from unnest(v_new_roles) x where private.is_project_role(x) and not (x = any(v_old_roles)))
     and not private.company_has('projects') then
    raise exception 'feature_disabled' using errcode = '22023';
  end if;

  update public.profiles set
    display_name = coalesce(private.clean_label(p_display_name), display_name),
    role = v_role,
    extra_roles = v_extra,
    is_active = coalesce(p_is_active, is_active)
  where id = p_user_id
  returning * into v_new;

  if 'admin' = any(v_old_roles) and v_old.is_active and (not ('admin' = any(v_new_roles)) or not v_new.is_active)
     and not private.is_super_admin()
     and not exists (select 1 from public.profiles p
       where p.company_id = v_company and (p.role = 'admin' or 'admin' = any(p.extra_roles)) and p.is_active) then
    raise exception 'last_admin' using errcode = '23514';
  end if;

  if v_old_roles && v_lead_roles and not (v_new_roles && v_lead_roles) and exists (
    select 1 from public.leads l where l.owner_id = p_user_id and l.archived_at is null
  ) then
    raise exception 'reassign_leads_first' using errcode = '23514';
  end if;

  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'user_updated', jsonb_strip_nulls(jsonb_build_object(
    'display_name', case when v_new.display_name <> v_old.display_name then jsonb_build_object('from', v_old.display_name, 'to', v_new.display_name) end,
    'role', case when v_new.role <> v_old.role then jsonb_build_object('from', v_old.role, 'to', v_new.role) end,
    'extra_roles', case when v_new.extra_roles is distinct from v_old.extra_roles then jsonb_build_object('from', v_old.extra_roles, 'to', v_new.extra_roles) end,
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
      and (p_role is null or p.role = p_role or p_role = any(p.extra_roles))
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
      'extra_roles', to_jsonb(pg.extra_roles),
      'is_active', pg.is_active, 'created_at', pg.created_at,
      'owned_active_leads', (select count(*) from public.leads l where l.owner_id = pg.id and l.archived_at is null)
    ) order by pg.rn), '[]'::jsonb) from page pg)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- ---------------------------------------------------------------------------
-- Older functions that listed people by a single role
-- ---------------------------------------------------------------------------
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
    for r in select p.id from public.profiles p where p.is_active and (p.role in ('sales', 'admin', 'super_admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]) loop
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
        where p.is_active and (p.role = 'sales' or 'sales' = any(p.extra_roles)) and p.company_id = c.id
      ) x;
      v_count := v_count + private.enqueue_for_company(c.id, array['admin']::public.app_role[], 'digest_admin',
        jsonb_build_object('date', v_day, 'rows', v_rows), 'digest_admin:' || v_day || ':' || c.id);
    end if;

  end loop;

  -- Monthly finance summary for the previous month, per set of books, 1st of the month 09:00–11:59 IST.
  if extract(day from v_local) = 1 and v_hour between 9 and 11 then
    for c in
      select g.id as group_id, (select x.id from public.companies x where x.finance_group_id = g.id and x.archived_at is null
                                order by x.created_at, x.id limit 1) as company_id,
        (select array_agg(x.id) from public.companies x where x.finance_group_id = g.id and x.archived_at is null) as ids
      from public.finance_groups g
      where exists (select 1 from public.companies x where x.finance_group_id = g.id and x.archived_at is null)
    loop
      select jsonb_build_object(
        'month', to_char(v_prev_month, 'YYYY-MM'),
        'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.company_id = any(c.ids) and e.archived_at is null
          and e.expense_date >= v_prev_month and e.expense_date < v_month_start), 0),
        'expense_count', (select count(*) from public.expenses e where e.company_id = any(c.ids) and e.archived_at is null
          and e.expense_date >= v_prev_month and e.expense_date < v_month_start),
        'categories', coalesce((select jsonb_agg(x order by x.total desc) from (
          select e.category, sum(e.amount) as total from public.expenses e
          where e.company_id = any(c.ids) and e.archived_at is null and e.expense_date >= v_prev_month and e.expense_date < v_month_start
          group by e.category) x), '[]'::jsonb),
        'capital_total', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id = any(c.ids) and k.archived_at is null
          and k.entry_date >= v_prev_month and k.entry_date < v_month_start), 0)
      ) into v_payload;
      v_count := v_count + private.enqueue_for_books(c.company_id, 'digest_finance',
        v_payload, 'digest_finance:' || to_char(v_prev_month, 'YYYY-MM') || ':' || c.group_id);
    end loop;
  end if;
  return v_count;
end $$;

create or replace function public.report_leads(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_bucket text;
  v_start timestamptz;
  v_end timestamptz;
  v_admin boolean := private.is_admin();
  v_company uuid := private.current_company_id();
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  v_bucket := private.report_bucket(p_from, p_to);
  v_start := p_from::timestamp at time zone 'Asia/Kolkata';
  v_end := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';

  with
  -- The same leads RLS allows (company; admin: all, sales: own), filtered once instead of per row.
  vl as (
    select l.* from public.leads l
    where l.archived_at is null and l.company_id = v_company and (v_admin or l.owner_id = v_uid)),
  created as (select l.* from vl l where l.created_at >= v_start and l.created_at < v_end),
  act as (
    select a.* from public.lead_activities a join vl l on l.id = a.lead_id
    where a.created_at >= v_start and a.created_at < v_end),
  closes as (
    select distinct on (a.lead_id, a.meta ->> 'to_kind') a.lead_id, a.meta ->> 'to_kind' as outcome, a.created_at
    from act a where a.type = 'status_changed' and a.meta ->> 'to_kind' in ('won', 'lost')
    order by a.lead_id, a.meta ->> 'to_kind', a.created_at),
  fu as (select f.* from public.follow_ups f join vl l on l.id = f.lead_id),
  stages as (
    select s.id, s.name, s.kind, s.color, s.position,
      row_number() over (order by case when s.kind = 'won' then 1 else 0 end, s.position, s.id) as rnk
    from public.pipeline_stages s
    where s.company_id = v_company and s.archived_at is null and s.kind <> 'lost'),
  reached as (
    select c.id, max(r.rnk) as rnk
    from created c
    left join public.lead_activities a on a.lead_id = c.id and a.type = 'status_changed'
    join stages r on r.rnk = 1 or r.id = c.stage_id or r.id::text = a.meta ->> 'to_stage_id'
    group by c.id)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'bucket', v_bucket),
    'scope', case when v_admin then 'team' else 'mine' end,
    'cards', jsonb_build_object(
      'created', (select count(*) from created),
      'won', (select count(*) from closes where outcome = 'won'),
      'lost', (select count(*) from closes where outcome = 'lost'),
      'notes', (select count(*) from act where type = 'note'),
      'calls', (select count(*) from act where type::text = 'call_logged'),
      'follow_ups_scheduled', (select count(*) from fu where fu.created_at >= v_start and fu.created_at < v_end),
      'follow_ups_completed', (select count(*) from fu where fu.completed_at >= v_start and fu.completed_at < v_end),
      'overdue_now', (select count(*) from fu where fu.state = 'pending' and fu.due_at < now()),
      'avg_days_to_win', (
        select round(avg(extract(epoch from (c.created_at - l.created_at)) / 86400)::numeric, 1)
        from closes c join vl l on l.id = c.lead_id where c.outcome = 'won')),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', p.period, 'created', coalesce(n.cnt, 0), 'won', coalesce(w.won, 0), 'lost', coalesce(w.lost, 0)
      ) order by p.period), '[]'::jsonb)
      from private.report_periods(p_from, p_to, v_bucket) p
      left join (
        select date_trunc(v_bucket, c.created_at at time zone 'Asia/Kolkata')::date as period, count(*) as cnt
        from created c group by 1
      ) n on n.period = p.period
      left join (
        select date_trunc(v_bucket, c.created_at at time zone 'Asia/Kolkata')::date as period,
          count(*) filter (where c.outcome = 'won') as won, count(*) filter (where c.outcome = 'lost') as lost
        from closes c group by 1
      ) w on w.period = p.period),
    'activity_trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', p.period,
        'notes', coalesce(t.notes, 0), 'calls', coalesce(t.calls, 0), 'follow_ups', coalesce(t.follow_ups, 0)
      ) order by p.period), '[]'::jsonb)
      from private.report_periods(p_from, p_to, v_bucket) p
      left join (
        select date_trunc(v_bucket, a.created_at at time zone 'Asia/Kolkata')::date as period,
          count(*) filter (where a.type = 'note') as notes,
          count(*) filter (where a.type::text = 'call_logged') as calls,
          count(*) filter (where a.type = 'follow_up_completed') as follow_ups
        from act a group by 1
      ) t on t.period = p.period),
    'cohort_status', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', s.cnt)
        order by s.position, s.id), '[]'::jsonb)
      from (
        select st.id, st.name, st.kind, st.color, st.position, count(*) as cnt
        from created c join public.pipeline_stages st on st.id = c.stage_id group by st.id
      ) s),
    'funnel', (
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'kind', r.kind, 'color', r.color,
        'count', (select count(*) from reached x where x.rnk >= r.rnk)) order by r.rnk), '[]'::jsonb)
      from stages r),
    'niches', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'created', t.created, 'won', t.won) order by t.created desc, t.name), '[]'::jsonb)
      from (
        select n.name, count(*) as created, count(*) filter (where c.status = 'won') as won
        from created c join public.niches n on n.id = c.niche_id
        group by n.name order by count(*) desc, n.name limit 10
      ) t),
    'activity_types', (
      select coalesce(jsonb_agg(jsonb_build_object('type', t.type, 'count', t.cnt) order by t.cnt desc, t.type), '[]'::jsonb)
      from (select a.type::text as type, count(*) as cnt from act a group by a.type) t),
    'heatmap', (
      select coalesce(jsonb_agg(jsonb_build_object('dow', t.dow, 'hour', t.hour, 'count', t.cnt)), '[]'::jsonb)
      from (
        select extract(isodow from a.created_at at time zone 'Asia/Kolkata')::int as dow,
               extract(hour from a.created_at at time zone 'Asia/Kolkata')::int as hour, count(*) as cnt
        from act a where a.type <> 'lead_created' group by 1, 2
      ) t),
    'follow_up_outcomes', (
      select jsonb_build_object(
        'on_time', count(*) filter (where f.state = 'completed' and f.completed_at <= f.due_at),
        'late', count(*) filter (where f.state = 'completed' and f.completed_at > f.due_at),
        'cancelled', count(*) filter (where f.state = 'cancelled'),
        'overdue', count(*) filter (where f.state = 'pending' and f.due_at < now()),
        'upcoming', count(*) filter (where f.state = 'pending' and f.due_at >= now()))
      from fu f where f.due_at >= v_start and f.due_at < v_end),
    'salespeople', case when not v_admin then null else (
      select coalesce(jsonb_agg(x order by (x ->> 'created')::int desc, x ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.display_name,
          'created', (select count(*) from created c where c.owner_id = p.id),
          'won', (select count(*) from closes c join vl l on l.id = c.lead_id where c.outcome = 'won' and l.owner_id = p.id),
          'lost', (select count(*) from closes c join vl l on l.id = c.lead_id where c.outcome = 'lost' and l.owner_id = p.id),
          'follow_ups_completed', (select count(*) from fu where fu.completed_by = p.id and fu.completed_at >= v_start and fu.completed_at < v_end),
          'notes', (select count(*) from act a where a.actor_id = p.id and a.type = 'note'),
          'calls', (select count(*) from act a where a.actor_id = p.id and a.type::text = 'call_logged')) as x
        from public.profiles p
        where (p.role in ('sales', 'admin', 'super_admin') or p.extra_roles && array['sales', 'admin']::public.app_role[])
          -- This company's people, plus anyone else (e.g. the super admin) who owns its leads.
          and ((p.company_id = v_company and p.is_active) or exists (select 1 from vl l where l.owner_id = p.id))
        order by p.display_name
        limit 30
      ) t) end
  ) into v_result;
  return v_result;
end $$;

create or replace function public.ingest_meta_lead(
  p_company_id uuid, p_leadgen_id text, p_name text, p_phone text, p_phone_normalized text,
  p_email text default null, p_form_id text default null, p_form_name text default null, p_ad_name text default null,
  p_campaign_name text default null, p_answers text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event public.meta_lead_events%rowtype;
  v_owner uuid;
  v_niche uuid;
  v_niche_name text := coalesce(left(private.clean_label(p_form_name), 60), 'Facebook Lead Ads');
  v_existing uuid;
  v_lead uuid;
  v_source jsonb := jsonb_strip_nulls(jsonb_build_object('form_id', p_form_id, 'form_name', p_form_name, 'ad_name', p_ad_name,
    'campaign_name', p_campaign_name, 'leadgen_id', p_leadgen_id));
begin
  insert into public.meta_lead_events (company_id, leadgen_id, form_id)
  values (p_company_id, p_leadgen_id, p_form_id) on conflict (leadgen_id) do nothing;
  select * into v_event from public.meta_lead_events e where e.leadgen_id = p_leadgen_id and e.company_id = p_company_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_event.state in ('created', 'duplicate') then
    return jsonb_build_object('state', v_event.state, 'lead_id', v_event.lead_id);
  end if;
  update public.meta_lead_events set form_id = coalesce(p_form_id, form_id), form_name = p_form_name, ad_name = p_ad_name,
    campaign_name = p_campaign_name, attempts = attempts + 1
  where id = v_event.id;

  if p_phone_normalized is null or p_phone_normalized !~ '^\+[1-9][0-9]{6,14}$' then
    update public.meta_lead_events set state = 'failed', error = 'No valid phone number in the form answers.' where id = v_event.id;
    return jsonb_build_object('state', 'failed');
  end if;

  -- Same phone already in this company: keep one lead, note the new submission on it.
  select l.id into v_existing from public.leads l
  where l.company_id = p_company_id and l.phone_normalized = p_phone_normalized and l.archived_at is null
  order by l.created_at limit 1;
  if v_existing is not null then
    insert into public.lead_activities (lead_id, actor_id, type, body)
    values (v_existing, null, 'note', left(concat_ws(E'\n', 'Submitted the Facebook form "' || coalesce(p_form_name, 'Lead form') || '" again.',
      nullif(btrim(coalesce(p_answers, '')), '')), 5000));
    update public.meta_lead_events set state = 'duplicate', lead_id = v_existing, error = null where id = v_event.id;
    return jsonb_build_object('state', 'duplicate', 'lead_id', v_existing);
  end if;

  -- Round-robin among routed, active users of the company (locked so parallel webhooks take turns).
  select r.user_id into v_owner
  from public.meta_lead_routing r
  join public.profiles p on p.id = r.user_id and p.is_active and p.company_id = p_company_id and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[])
  where r.company_id = p_company_id
  order by r.last_assigned_at nulls first, r.user_id
  limit 1
  for update of r;
  if v_owner is not null then
    update public.meta_lead_routing set last_assigned_at = clock_timestamp() where company_id = p_company_id and user_id = v_owner;
  else
    select p.id into v_owner from public.profiles p
    where p.company_id = p_company_id and p.is_active and (p.role = 'admin' or 'admin' = any(p.extra_roles)) order by p.created_at, p.id limit 1;
  end if;
  if v_owner is null then
    select p.id into v_owner from public.profiles p where p.role = 'super_admin' and p.is_active order by p.created_at, p.id limit 1;
  end if;

  insert into public.niches (company_id, name) values (p_company_id, v_niche_name)
  on conflict (company_id, normalized_name) do nothing;
  select coalesce(n.merged_into_id, n.id) into v_niche from public.niches n
  where n.company_id = p_company_id and n.normalized_name = lower(regexp_replace(v_niche_name, '\s+', ' ', 'g'));

  insert into public.leads (company_id, name, phone, phone_normalized, email, niche_id, owner_id, created_by, source, source_meta)
  values (p_company_id, left(coalesce(private.clean_label(p_name), 'Facebook lead'), 120), left(p_phone, 32), p_phone_normalized,
    case when p_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(p_email) <= 254 then lower(btrim(p_email)) end,
    v_niche, v_owner, v_owner, 'facebook', v_source)
  returning id into v_lead;

  -- The timeline shows where the lead came from rather than the owner "creating" it.
  update public.lead_activities set actor_id = null, meta = meta || jsonb_build_object('source', 'facebook', 'form', p_form_name)
  where lead_id = v_lead and type = 'lead_created';
  if nullif(btrim(coalesce(p_answers, '')), '') is not null then
    insert into public.lead_activities (lead_id, actor_id, type, body)
    values (v_lead, null, 'note', left('Facebook form answers:' || E'\n' || p_answers, 5000));
  end if;
  -- The owner did not create it themselves, so tell them (the creation notice skips its "author").
  perform private.enqueue_notification(v_owner, 'lead_assigned', jsonb_build_object(
    'lead_id', v_lead, 'lead_name', p_name, 'phone', p_phone, 'niche', v_niche_name,
    'owner', private.display_name(v_owner), 'actor', 'Facebook Lead Ads'), 'lead_assigned:fb:' || v_lead, null, v_lead);

  update public.meta_lead_events set state = 'created', lead_id = v_lead, error = null where id = v_event.id;
  return jsonb_build_object('state', 'created', 'lead_id', v_lead, 'owner_id', v_owner);
end $$;

create or replace function public.set_meta_routing(p_company_id uuid, p_user_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) x where not exists (
    select 1 from public.profiles p where p.id = x and p.company_id = p_company_id and p.is_active and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  delete from public.meta_lead_routing r where r.company_id = p_company_id and not (r.user_id = any(coalesce(p_user_ids, '{}')));
  insert into public.meta_lead_routing (company_id, user_id)
  select p_company_id, x from unnest(coalesce(p_user_ids, '{}')) x
  on conflict do nothing;
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
    where c.archived_at is null and private.can_manage_meta(c.id)
  );
end $$;

create or replace function public.telegram_bot_summary(p_chat_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_day date := (v_now at time zone 'Asia/Kolkata')::date;
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_day_end timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_month_start date := date_trunc('month', v_day)::date;
  v_next_month date := (date_trunc('month', v_day) + interval '1 month')::date;
  v_user record;
  v_company uuid;
  v_roles text[];
  v_out jsonb;
begin
  select p.id, p.display_name, p.role::text as role, coalesce(p.active_company_id, p.company_id) as company_id,
    array[p.role::text] || p.extra_roles::text[] as roles
    into v_user
  from public.telegram_connections t
  join public.profiles p on p.id = t.user_id and p.is_active
  where t.chat_id = p_chat_id and t.status = 'connected';
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  v_company := v_user.company_id;
  v_roles := v_user.roles;
  v_out := jsonb_build_object('connected', true, 'name', v_user.display_name, 'role', v_user.role, 'roles', to_jsonb(v_roles), 'date', v_day);

  -- My follow-ups (people who own leads).
  if v_roles && array['sales', 'admin', 'super_admin'] then
    v_out := v_out || (
      select jsonb_build_object(
        'today', count(*) filter (where f.due_at >= v_day_start and f.due_at < v_day_end),
        'overdue', count(*) filter (where f.due_at < v_now))
      from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.assignee_id = v_user.id and f.state = 'pending'
    ) || jsonb_build_object('tasks', (
      select coalesce(jsonb_agg(t order by t.due_at, t.id), '[]'::jsonb) from (
        select f.id, f.task, f.due_at, l.name as lead_name, f.due_at < v_now as overdue
        from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where f.assignee_id = v_user.id and f.state = 'pending' and f.due_at < v_day_end
        order by f.due_at, f.id limit 5
      ) t));
  end if;

  -- Admin: the company's day at a glance.
  if v_roles && array['admin', 'super_admin'] and v_company is not null then
    v_out := v_out || jsonb_build_object('team', jsonb_build_object(
      'new_leads', (select count(*) from public.leads l
        where l.company_id = v_company and l.created_at >= v_day_start and l.created_at < v_day_end),
      'won', (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id
        where l.company_id = v_company and a.type = 'status_changed'
          and coalesce(a.meta ->> 'to_kind', a.meta ->> 'to') = 'won'
          and a.created_at >= v_day_start and a.created_at < v_day_end),
      'overdue', (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where l.company_id = v_company and f.state = 'pending' and f.due_at < v_now)));
  end if;

  -- Account: this month in the user's books (every company sharing them).
  if 'account' = any(v_roles) and v_company is not null then
    v_out := v_out || (
      with books as (
        select x.id from public.companies x
        where x.archived_at is null
          and x.finance_group_id = (select c.finance_group_id from public.companies c where c.id = v_company)
      )
      select jsonb_build_object('finance', jsonb_build_object(
        'month', to_char(v_month_start, 'YYYY-MM'),
        'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.company_id in (select id from books)
          and e.archived_at is null and e.expense_date >= v_month_start and e.expense_date < v_next_month), 0),
        'expense_count', (select count(*) from public.expenses e where e.company_id in (select id from books)
          and e.archived_at is null and e.expense_date >= v_month_start and e.expense_date < v_next_month),
        'capital_total', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id in (select id from books)
          and k.archived_at is null and k.entry_date >= v_month_start and k.entry_date < v_next_month), 0)))
    );
  end if;

  -- Ads manager: ad accounts that stopped syncing, in the companies they manage.
  if v_user.role = 'ads_manager' then
    v_out := v_out || (
      select jsonb_build_object('ads', jsonb_build_object(
        'problem_count', count(*),
        'problem_names', coalesce((array_agg(coalesce(a.name, 'act_' || a.act_id) order by a.name nulls last))[1:3], '{}')))
      from public.ad_accounts a
      join public.ads_manager_companies m on m.company_id = a.company_id and m.user_id = v_user.id
      where a.status = 'error'
    );
  end if;

  return v_out;
end $$;

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
      p.is_active, p.role, p.extra_roles, p.company_id, t.chat_id as t_chat, t.status as t_status, s.disabled_kinds
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
    if not r.is_active or not (r.kind = any(private.notification_kinds_for_roles(r.role, r.extra_roles))) then
      v_skip := 'recipient_inactive';
    elsif r.kind <> 'test' and r.kind = any(coalesce(r.disabled_kinds, '{}')) then
      v_skip := 'disabled_by_user';
    elsif r.lead_id is not null and not exists (
      select 1 from public.leads l
      where l.id = r.lead_id and l.archived_at is null
        and (r.role = 'super_admin' or ((r.role = 'admin' or 'admin' = any(r.extra_roles)) and l.company_id = r.company_id) or l.owner_id = r.recipient_id)) then
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

-- Companies with their size and modules, for Super settings.
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
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.company_has(text),
  private.is_project_role(public.app_role),
  private.apply_projects_pipeline(uuid),
  private.my_roles(),
  private.has_role(public.app_role),
  private.notification_kinds_for_roles(public.app_role, public.app_role[]),
  public.set_company_feature(uuid, text, boolean),
  public.admin_update_user(uuid, text, public.app_role, boolean, public.app_role[])
from public, anon, authenticated;

grant execute on function
  private.company_has(text),
  private.is_project_role(public.app_role),
  private.my_roles(),
  private.has_role(public.app_role)
to authenticated, service_role;
grant execute on function private.notification_kinds_for_roles(public.app_role, public.app_role[]) to service_role;
grant execute on function
  public.set_company_feature(uuid, text, boolean),
  public.admin_update_user(uuid, text, public.app_role, boolean, public.app_role[])
to authenticated;
