-- ---------------------------------------------------------------------------
-- Sales users across our companies. The super admin ticks other companies of ours for a sales user
-- (Super settings → Sales team); they switch there at the top left like ads managers do and work as
-- Sales: their own and assigned leads, follow-ups and dashboard. They can be picked as a lead's owner
-- and in Facebook lead routing there. Client CRMs (workspaces) are not offered.
--
-- * sales_member(user, company) is re-read on every call: unticking a company, deactivating the user,
--   taking away their sales role or archiving either company ends access at once.
-- * Leads they own in a company they leave stay theirs; an admin there reassigns them.
-- * Starts from 4000's ingest_meta_lead (apply 4000 first; any later change starts from this one).
-- ---------------------------------------------------------------------------

create table public.sales_user_companies (
  user_id uuid not null references public.profiles (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, company_id)
);
create index sales_user_companies_company_idx on public.sales_user_companies (company_id);
alter table public.sales_user_companies enable row level security;
revoke all on public.sales_user_companies from anon, authenticated;

-- Whether p_user, an active sales user of another active company of ours, also works in p_company.
-- Never calls current_company_id() (which uses it).
create function private.sales_member(p_user uuid, p_company uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.sales_user_companies s
    join public.companies c on c.id = s.company_id and c.archived_at is null and c.parent_company_id is null
    join public.profiles p on p.id = s.user_id and p.is_active and p.company_id is distinct from c.id
      and (p.role = 'sales' or 'sales' = any(p.extra_roles))
    join public.companies h on h.id = p.company_id and h.archived_at is null
    where s.user_id = p_user and s.company_id = p_company
  )
$$;

-- The companies the signed-in sales user switches between: their own plus the ticked ones, or none
-- when nothing is ticked.
create function private.sales_switch_company_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  with extra as (
    select s.company_id from public.sales_user_companies s
    where s.user_id = (select auth.uid()) and private.sales_member(s.user_id, s.company_id)
  )
  select case when exists (select 1 from extra)
    then array(select e.company_id from extra e) || (select p.company_id from public.profiles p where p.id = (select auth.uid()))
    else '{}'::uuid[] end
$$;

-- As before, plus: a sales user whose chosen company is one they were ticked for works there.
create or replace function private.current_company_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select case
    when p.role = 'super_admin' then coalesce(
      (select c.id from public.companies c where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1))
    when p.active_company_id is not null and p.active_company_id is distinct from p.company_id
         and (private.workspace_staff(p.id, p.active_company_id) or private.sales_member(p.id, p.active_company_id)) then p.active_company_id
    when p.role = 'ads_manager' then coalesce(
      (select c.id from public.companies c join public.ads_manager_companies a on a.company_id = c.id and a.user_id = p.id
        where c.id = p.active_company_id and c.archived_at is null),
      (select c.id from public.companies c join public.ads_manager_companies a on a.company_id = c.id and a.user_id = p.id
        where c.archived_at is null order by c.created_at, c.id limit 1))
    else (select c.id from public.companies c where c.id = p.company_id and c.archived_at is null) end
  from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

-- In another of our companies a visiting sales user is Sales only.
create or replace function private.my_roles()
returns public.app_role[]
language sql stable security definer set search_path = ''
as $$
  select case
    when w.parent_company_id is not null and p.company_id is distinct from w.id then array['admin']::public.app_role[]
    when p.role not in ('super_admin', 'ads_manager') and p.company_id is distinct from w.id then array['sales']::public.app_role[]
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
    -- In another of our companies (sales_member) they are Sales only, whatever they are at home.
    when w.parent_company_id is null and p.role <> 'ads_manager' and p.company_id is distinct from w.id then 'sales'::public.app_role
    when p.role = 'admin' or 'admin' = any(p.extra_roles) then 'admin'::public.app_role
    when w.parent_company_id is not null and p.company_id is distinct from w.id then 'admin'::public.app_role
    when p.role = 'sales' or 'sales' = any(p.extra_roles) then 'sales'::public.app_role
    else p.role end
  from public.profiles p
  join public.companies w on w.id = private.current_company_id()
  where p.id = (select auth.uid()) and p.is_active
$$;

-- As before, plus the companies a sales user was ticked for.
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
          or private.sales_member((select auth.uid()), p_company_id)
          or exists (select 1 from public.profiles p where p.id = (select auth.uid())
                     and p.role not in ('super_admin', 'ads_manager') and p.company_id = p_company_id)) then
    perform private.raise_forbidden();
  end if;
  update public.profiles set active_company_id = p_company_id where id = (select auth.uid());
end $$;

create or replace function public.my_context()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'company_id', w.id,
    'roles', to_jsonb(private.my_roles()),
    -- A sales user working in another of our companies (sales_user_companies).
    'visiting', p.role not in ('super_admin', 'ads_manager') and w.parent_company_id is null and p.company_id is distinct from w.id,
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
    or id = any((select private.sales_switch_company_ids())::uuid[])
  );

-- Visiting sales users are visible where they work (owners, pickers, timeline).
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.app_role()) is not null and (select private.app_role()) <> 'client'
        and (company_id = (select private.current_company_id()) or role = 'super_admin'
          or ((select private.is_workspace(private.current_company_id()))
              and private.workspace_staff(id, (select private.current_company_id())))
          or private.sales_member(id, (select private.current_company_id()))))
    or ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]))
  );

-- Unchanged except that a visiting sales user may own leads in a company they were ticked for.
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
        or private.workspace_staff(p.id, new.company_id)
        -- A sales user of another of our companies who also works here.
        or private.sales_member(p.id, new.company_id))
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

create or replace function public.lead_company(p_lead_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'brand_highlight', c.brand_highlight, 'logo_path', c.logo_path)
  from public.leads l
  join public.companies c on c.id = l.company_id and c.archived_at is null
  join public.profiles p on p.id = (select auth.uid()) and p.is_active
  where l.id = p_lead_id
    and (p.role = 'super_admin' or c.id = any(private.ads_manager_company_ids())
      or private.workspace_staff(p.id, c.id) or p.company_id = c.id or private.sales_member(p.id, c.id))
$$;

create or replace function public.set_meta_routing(p_company_id uuid, p_user_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) x where not exists (
    select 1 from public.profiles p where p.id = x and p.is_active and p.role <> 'super_admin'
      and ((p.company_id = p_company_id and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
        or private.workspace_staff(p.id, p_company_id) or private.sales_member(p.id, p_company_id)))) then
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
        from public.profiles p where p.is_active and ((p.company_id = c.id and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
          or private.sales_member(p.id, c.id))), '[]'::jsonb),
      'leads_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'created' and e.created_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'failed' and e.created_at > now() - interval '7 days')
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c
    where c.archived_at is null and c.parent_company_id is null and private.can_manage_meta(c.id)
  );
end $$;

-- From 4000; routing also takes visiting sales users.
create or replace function public.ingest_meta_lead(
  p_company_id uuid, p_leadgen_id text, p_name text, p_phone text, p_phone_normalized text,
  p_email text default null, p_form_id text default null, p_form_name text default null, p_ad_name text default null,
  p_campaign_name text default null, p_answers text default null, p_campaign_id text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event public.meta_lead_events%rowtype;
  -- The CRM the lead goes to: the company whose connection received it, or a client's CRM.
  v_target uuid := p_company_id;
  -- A merged company whose category on our ad account the campaign is in.
  v_mapped uuid;
  v_owner uuid;
  v_niche uuid;
  v_niche_name text := coalesce(private.form_niche_name(p_form_name), 'Facebook Lead Ads');
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

  -- A campaign in the category of a company that shares this company's ad account: the lead
  -- belongs in that company's CRM.
  select k.company_id into v_mapped
  from public.ad_campaigns c
  join public.ad_accounts a on a.id = c.ad_account_id and a.company_id = p_company_id and a.kind = 'company'
  join public.ad_categories k on k.id = c.category_id and k.archived_at is null and k.company_id <> p_company_id
  join public.ad_account_members m on m.ad_account_id = a.id and m.company_id = k.company_id
  join public.companies t on t.id = k.company_id and t.archived_at is null
  where c.meta_id = nullif(btrim(coalesce(p_campaign_id, '')), '')
  limit 1;

  -- A campaign we run for an ads client (its category is linked to the client) whose CRM exists:
  -- the lead belongs in the client's CRM, not ours.
  select w.id into v_target
  from public.ad_campaigns c
  join public.ad_categories k on k.id = c.category_id and k.archived_at is null
  join public.ads_clients cl on cl.id = k.ads_client_id and cl.company_id = p_company_id
  join public.companies w on w.id = cl.workspace_company_id and w.archived_at is null
  where c.meta_id = nullif(btrim(coalesce(p_campaign_id, '')), '')
  limit 1;
  v_target := coalesce(v_mapped, v_target, p_company_id);

  -- Same phone already in this company: keep one lead, note the new submission on it.
  select l.id into v_existing from public.leads l
  where l.company_id = v_target and l.phone_normalized = p_phone_normalized and l.archived_at is null
  order by l.created_at limit 1;
  if v_existing is not null then
    insert into public.lead_activities (lead_id, actor_id, type, body)
    values (v_existing, null, 'note', left(concat_ws(E'\n', 'Submitted the Facebook form "' || coalesce(p_form_name, 'Lead form') || '" again.',
      nullif(btrim(coalesce(p_answers, '')), '')), 5000));
    update public.meta_lead_events set state = 'duplicate', lead_id = v_existing, error = null where id = v_event.id;
    return jsonb_build_object('state', 'duplicate', 'lead_id', v_existing);
  end if;

  -- Round-robin among routed, active users of the company, or of our team in a client's CRM
  -- (locked so parallel webhooks take turns).
  select r.user_id into v_owner
  from public.meta_lead_routing r
  join public.profiles p on p.id = r.user_id and p.is_active
    and ((p.company_id = v_target and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
      or private.workspace_staff(p.id, v_target) or private.sales_member(p.id, v_target))
  where r.company_id = v_target
  order by r.last_assigned_at nulls first, r.user_id
  limit 1
  for update of r;
  if v_owner is not null then
    update public.meta_lead_routing set last_assigned_at = clock_timestamp() where company_id = v_target and user_id = v_owner;
  else
    select p.id into v_owner from public.profiles p
    where p.company_id = v_target and p.is_active and (p.role = 'admin' or 'admin' = any(p.extra_roles)) order by p.created_at, p.id limit 1;
  end if;
  -- A client's CRM with no admin of its own: whoever on our team created it, else one of our admins.
  if v_owner is null then
    select p.id into v_owner from public.companies w
    join public.profiles p on p.is_active and p.role <> 'super_admin' and private.workspace_staff(p.id, w.id)
    where w.id = v_target and w.parent_company_id is not null
    order by (p.id is not distinct from w.created_by) desc, (p.company_id is not distinct from w.parent_company_id) desc, p.created_at, p.id
    limit 1;
  end if;
  if v_owner is null then
    select p.id into v_owner from public.profiles p where p.role = 'super_admin' and p.is_active order by p.created_at, p.id limit 1;
  end if;

  insert into public.niches (company_id, name) values (v_target, v_niche_name)
  on conflict (company_id, normalized_name) do nothing;
  select coalesce(n.merged_into_id, n.id) into v_niche from public.niches n
  where n.company_id = v_target and n.normalized_name = lower(regexp_replace(v_niche_name, '\s+', ' ', 'g'));

  insert into public.leads (company_id, name, phone, phone_normalized, email, niche_id, owner_id, created_by, source, source_meta)
  values (v_target, left(coalesce(private.clean_label(p_name), 'Facebook lead'), 120), left(p_phone, 32), p_phone_normalized,
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
  -- A bulk sync (ingest_meta_leads) sends one summary per person instead.
  if current_setting('crm.lead_import', true) is distinct from 'on' then
    perform private.enqueue_notification(v_owner, 'lead_assigned', jsonb_build_object(
      'lead_id', v_lead, 'lead_name', p_name, 'phone', p_phone, 'niche', v_niche_name,
      'owner', private.display_name(v_owner), 'actor', 'Facebook Lead Ads'), 'lead_assigned:fb:' || v_lead, null, v_lead);
  end if;

  update public.meta_lead_events set state = 'created', lead_id = v_lead, error = null where id = v_event.id;
  return jsonb_build_object('state', 'created', 'lead_id', v_lead, 'owner_id', v_owner, 'company_id', v_target);
end $$;

-- ---------------------------------------------------------------------------
-- Super admin: who works where
-- ---------------------------------------------------------------------------
create function public.super_list_sales_users()
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
      'company_ids', coalesce((select jsonb_agg(s.company_id order by x.created_at, x.id)
        from public.sales_user_companies s join public.companies x on x.id = s.company_id and x.archived_at is null
        where s.user_id = p.id), '[]'::jsonb)
    ) order by c.created_at, c.id, lower(p.display_name), p.id), '[]'::jsonb)
    from public.profiles p
    join public.companies c on c.id = p.company_id and c.archived_at is null and c.parent_company_id is null
    where p.is_active and (p.role = 'sales' or 'sales' = any(p.extra_roles))
  );
end $$;

-- Replaces the user's extra companies. Leaving a company also takes them out of its lead routing.
create function public.set_sales_user_companies(p_user_id uuid, p_company_ids uuid[])
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
    and exists (select 1 from public.companies c where c.id = r.company_id and c.parent_company_id is null);
  delete from public.sales_user_companies s where s.user_id = p_user_id and not (s.company_id = any(v_ids));
  insert into public.sales_user_companies (user_id, company_id)
  select p_user_id, x from unnest(v_ids) x
  on conflict do nothing;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'sales_user_companies', jsonb_build_object('company_ids', to_jsonb(v_ids)));
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.sales_member(uuid, uuid),
  private.sales_switch_company_ids(),
  public.super_list_sales_users(),
  public.set_sales_user_companies(uuid, uuid[])
from public, anon, authenticated;

grant execute on function private.sales_member(uuid, uuid), private.sales_switch_company_ids() to authenticated, service_role;
grant execute on function public.super_list_sales_users(), public.set_sales_user_companies(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
