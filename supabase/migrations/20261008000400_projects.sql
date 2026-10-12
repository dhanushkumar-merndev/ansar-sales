-- ---------------------------------------------------------------------------
-- Projects module (companies with the 'projects' feature, i.e. Star Gardens)
--
-- BDM hands an interested lead to Admin → Admin creates a project from it, assigns
-- the architect manager / landscape designers / execution team, and the phases
-- (the project timeline) from the template. Everything is scoped to the company
-- and to the people on the project:
--   * admin            — every project of the company
--   * account          — every project (summary + money; never design notes)
--   * team members     — the projects they are on
--   * clients          — nothing directly; their portal reads through definer RPCs
-- Money (area, rate, contract value) lives in project_financials so Realtime and
-- table reads never send it to the design team.
-- Lateness is derived (deadline passed and the phase not finished), never stored.
-- ---------------------------------------------------------------------------

create type public.project_status as enum ('active', 'on_hold', 'completed', 'cancelled');
create type public.project_member_role as enum ('architect_manager', 'landscape_designer', 'execution', 'client');
create type public.phase_status as enum ('not_started', 'in_progress', 'in_review', 'changes_requested', 'done', 'skipped');

-- ---------------------------------------------------------------------------
-- Leads: handoff to admin
-- ---------------------------------------------------------------------------
alter table public.leads
  add column handoff_at timestamptz,
  add column handoff_by uuid references public.profiles (id),
  add column handoff_note text check (handoff_note is null or char_length(handoff_note) <= 1000);
create index leads_handoff_idx on public.leads (company_id, handoff_at desc) where handoff_at is not null and archived_at is null;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default private.current_company_id() references public.companies (id),
  lead_id uuid unique references public.leads (id),
  code text not null check (char_length(code) between 3 and 24),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  client_name text not null check (char_length(btrim(client_name)) between 1 and 120),
  client_phone text check (client_phone is null or char_length(client_phone) <= 32),
  client_email text check (client_email is null or char_length(client_email) <= 254),
  site_address text check (site_address is null or char_length(site_address) <= 500),
  site_lat numeric(9, 6) check (site_lat is null or site_lat between -90 and 90),
  site_lng numeric(9, 6) check (site_lng is null or site_lng between -180 and 180),
  start_date date not null,
  end_date date not null,
  completed_on date,
  status public.project_status not null default 'active',
  color text not null default 'emerald' check (color ~ '^[a-z]{3,12}$'),
  storage_quota_bytes bigint not null default 107374182400 check (storage_quota_bytes > 0),
  version integer not null default 1,
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id),
  unique (company_id, code),
  check (end_date >= start_date)
);
create index projects_company_status_idx on public.projects (company_id, status, end_date) where archived_at is null;

create table public.project_financials (
  project_id uuid primary key references public.projects (id) on delete cascade,
  area_sqft numeric(12, 2) check (area_sqft is null or area_sqft > 0),
  rate_per_sqft numeric(12, 2) check (rate_per_sqft is null or rate_per_sqft >= 0),
  contract_value numeric(14, 2) check (contract_value is null or contract_value >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id)
);

create table public.project_members (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.profiles (id),
  member_role public.project_member_role not null,
  added_by uuid references public.profiles (id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.profiles (id)
);
create unique index project_members_active_key on public.project_members (project_id, user_id, member_role) where removed_at is null;
create index project_members_user_idx on public.project_members (user_id, project_id) where removed_at is null;

create table public.project_phases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  position integer not null default 0,
  category text not null default 'General' check (char_length(btrim(category)) between 1 and 60),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  color text not null default 'emerald' check (color ~ '^[a-z]{3,12}$'),
  owner_id uuid references public.profiles (id),
  planned_start date not null,
  deadline date not null,
  actual_start date,
  submitted_on date,
  status public.phase_status not null default 'not_started',
  needs_client_approval boolean not null default false,
  notes jsonb check (notes is null or (jsonb_typeof(notes) = 'object' and pg_column_size(notes) <= 200000)),
  remark text check (remark is null or char_length(remark) <= 500),
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (deadline >= planned_start)
);
create index project_phases_project_idx on public.project_phases (project_id, position, id) where archived_at is null;
create index project_phases_due_idx on public.project_phases (deadline) where archived_at is null and status not in ('done', 'skipped');
create index project_phases_owner_idx on public.project_phases (owner_id, deadline) where archived_at is null;

create table public.project_phase_items (
  id uuid primary key default gen_random_uuid(),
  phase_id uuid not null references public.project_phases (id) on delete cascade,
  position integer not null default 0,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  done_at timestamptz,
  done_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index project_phase_items_phase_idx on public.project_phase_items (phase_id, position, id) where archived_at is null;

create table public.project_activities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  actor_id uuid references public.profiles (id),
  type text not null check (type in (
    'project_created', 'project_updated', 'status_changed', 'member_added', 'member_removed', 'note',
    'phase_added', 'phase_updated', 'phase_rescheduled', 'phase_status_changed', 'phase_owner_changed', 'phase_removed')),
  body text check (body is null or char_length(body) <= 5000),
  phase_id uuid references public.project_phases (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index project_activities_project_idx on public.project_activities (project_id, created_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------
-- Staff who may see the project: admin, account, or an active (non-client) member.
create function private.can_access_project(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and p.company_id = private.current_company_id()
      and private.company_has('projects')
      and (private.is_admin() or private.has_role('account') or exists (
        select 1 from public.project_members m
        where m.project_id = p.id and m.user_id = (select auth.uid()) and m.removed_at is null and m.member_role <> 'client'))
  )
$$;

-- Admin, or the project's architect manager.
create function private.can_manage_project(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id
      and p.company_id = private.current_company_id()
      and private.company_has('projects')
      and (private.is_admin() or (private.has_role('architect_manager') and exists (
        select 1 from public.project_members m
        where m.project_id = p.id and m.user_id = (select auth.uid()) and m.removed_at is null
          and m.member_role = 'architect_manager')))
  )
$$;

create function private.can_see_project_money(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (private.is_admin() or private.has_role('account')) and private.can_access_project(p_project_id)
$$;

-- Does this person hold the role (main or extra), actively, in this company?
create function private.user_has_role(p_user_id uuid, p_company_id uuid, p_role public.app_role)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.is_active and p.company_id = p_company_id
      and (p.role = p_role or p_role = any(p.extra_roles)))
$$;

create function private.log_project(p_project_id uuid, p_type text, p_meta jsonb default '{}'::jsonb, p_phase_id uuid default null, p_body text default null)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.project_activities (project_id, actor_id, type, meta, phase_id, body)
  values (p_project_id, (select auth.uid()), p_type, coalesce(p_meta, '{}'::jsonb), p_phase_id, p_body)
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger projects_company_guard before insert or update or delete on public.projects
  for each row execute function private.company_guard();

create function private.projects_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.name := btrim(new.name);
  new.client_name := btrim(new.client_name);
  new.client_email := nullif(lower(btrim(coalesce(new.client_email, ''))), '');
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce(v_uid, new.created_by);
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  new.id := old.id;
  new.code := old.code;
  new.lead_id := old.lead_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.version := old.version + 1;
  new.updated_at := now();
  if v_uid is not null and (new.archived_at is distinct from old.archived_at or new.storage_quota_bytes is distinct from old.storage_quota_bytes)
     and not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if new.archived_at is distinct from old.archived_at then
    new.archived_by := case when new.archived_at is null then null else v_uid end;
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    new.completed_on := coalesce(new.completed_on, private.ist_today());
  elsif new.status <> 'completed' then
    new.completed_on := null;
  end if;
  return new;
end $$;

create trigger projects_before_write before insert or update on public.projects
  for each row execute function private.projects_before_write();

create function private.projects_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    return null;
  end if;
  if new.status is distinct from old.status then
    perform private.log_project(new.id, 'status_changed', jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.name is distinct from old.name then
    v_changes := v_changes || jsonb_build_object('Name', jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.client_name is distinct from old.client_name then
    v_changes := v_changes || jsonb_build_object('Client', jsonb_build_object('from', old.client_name, 'to', new.client_name));
  end if;
  if new.client_phone is distinct from old.client_phone then
    v_changes := v_changes || jsonb_build_object('Phone', jsonb_build_object('from', old.client_phone, 'to', new.client_phone));
  end if;
  if new.site_address is distinct from old.site_address then
    v_changes := v_changes || jsonb_build_object('Site address', jsonb_build_object('from', old.site_address, 'to', new.site_address));
  end if;
  if new.site_lat is distinct from old.site_lat or new.site_lng is distinct from old.site_lng then
    v_changes := v_changes || jsonb_build_object('Site pin', jsonb_build_object(
      'from', case when old.site_lat is null then null else old.site_lat || ', ' || old.site_lng end,
      'to', case when new.site_lat is null then null else new.site_lat || ', ' || new.site_lng end));
  end if;
  if new.start_date is distinct from old.start_date then
    v_changes := v_changes || jsonb_build_object('Start', jsonb_build_object('from', old.start_date, 'to', new.start_date));
  end if;
  if new.end_date is distinct from old.end_date then
    v_changes := v_changes || jsonb_build_object('End', jsonb_build_object('from', old.end_date, 'to', new.end_date));
  end if;
  if v_changes <> '{}'::jsonb then
    perform private.log_project(new.id, 'project_updated', jsonb_build_object('changes', v_changes));
  end if;
  return null;
end $$;

create trigger projects_after_write after insert or update on public.projects
  for each row execute function private.projects_after_write();

create trigger project_financials_touch before update on public.project_financials
  for each row execute function private.touch_updated_at();

create function private.project_phases_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_manager boolean;
begin
  new.name := btrim(new.name);
  new.category := coalesce(private.clean_label(new.category), 'General');
  new.remark := private.clean_label(new.remark);
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce(v_uid, new.created_by);
    new.created_at := now();
    new.updated_at := now();
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    new.updated_at := now();
    -- The phase owner (not a manager) may only report progress.
    if v_uid is not null then
      v_manager := private.can_manage_project(old.project_id);
      if not v_manager and (
        new.name is distinct from old.name or new.category is distinct from old.category
        or new.color is distinct from old.color or new.owner_id is distinct from old.owner_id
        or new.planned_start is distinct from old.planned_start or new.deadline is distinct from old.deadline
        or new.position is distinct from old.position or new.needs_client_approval is distinct from old.needs_client_approval
        or new.archived_at is distinct from old.archived_at
      ) then
        perform private.raise_forbidden();
      end if;
    end if;
  end if;

  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) and not exists (
    select 1 from public.project_members m
    where m.project_id = new.project_id and m.user_id = new.owner_id and m.removed_at is null and m.member_role <> 'client'
  ) and not private.user_has_role(new.owner_id, (select p.company_id from public.projects p where p.id = new.project_id), 'admin') then
    raise exception 'owner_not_on_project' using errcode = '22023';
  end if;

  -- Progress dates follow the status unless set explicitly.
  if new.status in ('in_progress', 'in_review', 'changes_requested', 'done') and new.actual_start is null then
    new.actual_start := least(private.ist_today(), coalesce(new.submitted_on, private.ist_today()));
  end if;
  if new.status in ('in_review', 'done') and new.submitted_on is null then
    new.submitted_on := private.ist_today();
  end if;
  if new.status in ('not_started', 'in_progress', 'changes_requested') and tg_op = 'UPDATE'
     and old.status in ('in_review', 'done') and new.submitted_on is not distinct from old.submitted_on then
    new.submitted_on := null;
  end if;
  if new.status = 'not_started' and tg_op = 'UPDATE' and new.actual_start is not distinct from old.actual_start then
    new.actual_start := null;
  end if;
  return new;
end $$;

create trigger project_phases_before_write before insert or update on public.project_phases
  for each row execute function private.project_phases_before_write();

create function private.project_phases_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_changes jsonb := '{}'::jsonb;
begin
  -- The project creation itself logs one event, not one per template phase.
  if tg_op = 'INSERT' then
    if exists (select 1 from public.project_activities a where a.project_id = new.project_id and a.type = 'project_created') then
      perform private.log_project(new.project_id, 'phase_added', jsonb_build_object('phase', new.name, 'category', new.category,
        'start', new.planned_start, 'deadline', new.deadline), new.id);
    end if;
    return null;
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform private.log_project(new.project_id, case when new.archived_at is null then 'phase_added' else 'phase_removed' end,
      jsonb_build_object('phase', new.name, 'category', new.category), new.id);
    return null;
  end if;
  if new.status is distinct from old.status then
    perform private.log_project(new.project_id, 'phase_status_changed', jsonb_build_object('phase', new.name,
      'from', old.status, 'to', new.status, 'deadline', new.deadline, 'submitted_on', new.submitted_on), new.id);
  end if;
  if new.planned_start is distinct from old.planned_start or new.deadline is distinct from old.deadline then
    perform private.log_project(new.project_id, 'phase_rescheduled', jsonb_build_object('phase', new.name,
      'from', jsonb_build_object('start', old.planned_start, 'deadline', old.deadline),
      'to', jsonb_build_object('start', new.planned_start, 'deadline', new.deadline)), new.id);
  end if;
  if new.owner_id is distinct from old.owner_id then
    perform private.log_project(new.project_id, 'phase_owner_changed', jsonb_build_object('phase', new.name,
      'from', private.display_name(old.owner_id), 'to', private.display_name(new.owner_id)), new.id);
  end if;
  if new.name is distinct from old.name then
    v_changes := v_changes || jsonb_build_object('Name', jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.category is distinct from old.category then
    v_changes := v_changes || jsonb_build_object('Stage', jsonb_build_object('from', old.category, 'to', new.category));
  end if;
  if new.submitted_on is distinct from old.submitted_on and new.status is not distinct from old.status then
    v_changes := v_changes || jsonb_build_object('Submitted on', jsonb_build_object('from', old.submitted_on, 'to', new.submitted_on));
  end if;
  if v_changes <> '{}'::jsonb then
    perform private.log_project(new.project_id, 'phase_updated', jsonb_build_object('phase', new.name, 'changes', v_changes), new.id);
  end if;
  return null;
end $$;

create trigger project_phases_after_write after insert or update on public.project_phases
  for each row execute function private.project_phases_after_write();

create function private.project_phase_items_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
  else
    new.id := old.id;
    new.phase_id := old.phase_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.done_at is not null and (tg_op = 'INSERT' or old.done_at is null) then
    new.done_at := now();
    new.done_by := (select auth.uid());
  elsif new.done_at is null then
    new.done_by := null;
  end if;
  return new;
end $$;

create trigger project_phase_items_before_write before insert or update on public.project_phase_items
  for each row execute function private.project_phase_items_before_write();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.projects enable row level security;
alter table public.project_financials enable row level security;
alter table public.project_members enable row level security;
alter table public.project_phases enable row level security;
alter table public.project_phase_items enable row level security;
alter table public.project_activities enable row level security;

create policy projects_select on public.projects for select to authenticated
  using (company_id = (select private.current_company_id()) and (select private.can_access_project(id)));
create policy projects_update on public.projects for update to authenticated
  using ((select private.can_manage_project(id)))
  with check ((select private.can_manage_project(id)));

create policy project_financials_select on public.project_financials for select to authenticated
  using ((select private.can_see_project_money(project_id)));

create policy project_members_select on public.project_members for select to authenticated
  using ((select private.can_access_project(project_id)));

create policy project_phases_select on public.project_phases for select to authenticated
  using ((select private.can_access_project(project_id)));
create policy project_phases_insert on public.project_phases for insert to authenticated
  with check ((select private.can_manage_project(project_id)));
create policy project_phases_update on public.project_phases for update to authenticated
  using ((select private.can_manage_project(project_id))
         or (owner_id = (select auth.uid()) and (select private.can_access_project(project_id))))
  with check ((select private.can_access_project(project_id)));

create policy project_phase_items_select on public.project_phase_items for select to authenticated
  using (exists (select 1 from public.project_phases ph where ph.id = phase_id));
create policy project_phase_items_write on public.project_phase_items for insert to authenticated
  with check (exists (select 1 from public.project_phases ph where ph.id = phase_id
    and ((select private.can_manage_project(ph.project_id)) or ph.owner_id = (select auth.uid()))));
create policy project_phase_items_update on public.project_phase_items for update to authenticated
  using (exists (select 1 from public.project_phases ph where ph.id = phase_id
    and ((select private.can_manage_project(ph.project_id)) or ph.owner_id = (select auth.uid()))));

create policy project_activities_select on public.project_activities for select to authenticated
  using ((select private.can_access_project(project_id)));

revoke all on public.projects, public.project_financials, public.project_members, public.project_phases,
  public.project_phase_items, public.project_activities from anon, authenticated;
grant select on public.projects, public.project_financials, public.project_members, public.project_phases,
  public.project_phase_items, public.project_activities to authenticated;
grant update (name, client_name, client_phone, client_email, site_address, site_lat, site_lng, start_date, end_date,
  status, color, archived_at) on public.projects to authenticated;
grant insert (project_id, position, category, name, color, owner_id, planned_start, deadline, actual_start, submitted_on,
  status, needs_client_approval, notes, remark) on public.project_phases to authenticated;
grant update (position, category, name, color, owner_id, planned_start, deadline, actual_start, submitted_on,
  status, needs_client_approval, notes, remark, archived_at) on public.project_phases to authenticated;
grant insert (phase_id, position, title, done_at) on public.project_phase_items to authenticated;
grant update (position, title, done_at, archived_at) on public.project_phase_items to authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
-- BDM (own lead) or admin: hand an interested lead to the admins to start a project.
create function public.handoff_lead(p_lead_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
begin
  if not private.is_lead_user() or not private.company_has('projects') or not private.can_access_lead(p_lead_id) then
    perform private.raise_forbidden();
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if v_lead.archived_at is not null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.projects p where p.lead_id = p_lead_id) then
    raise exception 'project_exists' using errcode = '23505';
  end if;
  if v_lead.handoff_at is not null then
    raise exception 'already_handed_off' using errcode = '23505';
  end if;
  update public.leads set handoff_at = now(), handoff_by = (select auth.uid()), handoff_note = left(private.clean_label(p_note), 1000)
  where id = p_lead_id;
  insert into public.lead_activities (lead_id, actor_id, type, body)
  values (p_lead_id, (select auth.uid()), 'handed_off', left(private.clean_label(p_note), 1000));
end $$;

-- Admin: leads handed over and waiting for a project.
create function public.list_handoff_leads(p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_admin() or not private.company_has('projects') then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(x order by x.handoff_at desc, x.id), '[]'::jsonb) from (
      select l.id, l.name, l.phone, l.email, l.handoff_at, l.handoff_note,
        jsonb_build_object('id', o.id, 'display_name', o.display_name) as owner,
        private.display_name(l.handoff_by) as handed_by,
        (select s.name from public.pipeline_stages s where s.id = l.stage_id) as stage
      from public.leads l
      join public.profiles o on o.id = l.owner_id
      where l.company_id = private.current_company_id() and l.handoff_at is not null and l.archived_at is null
        and not exists (select 1 from public.projects p where p.lead_id = l.id)
      order by l.handoff_at desc, l.id
      limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) x
  );
end $$;

-- Initials of the company name for project codes ("Star Gardens" → "SG").
create function private.company_code_prefix(p_company_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(nullif(left(upper(string_agg(left(w, 1), '' order by n)), 3), ''), 'PR')
  from public.companies c, regexp_split_to_table(regexp_replace(c.name, '[^A-Za-z0-9 ]', '', 'g'), '\s+') with ordinality as t(w, n)
  where c.id = p_company_id and w <> ''
$$;

-- Admin: creates a project (optionally from a lead) with its team and timeline in one transaction.
-- p_members: [{user_id, role}]; p_phases: [{category, name, color, planned_start, deadline,
-- needs_client_approval, owner_id?, items: [title]}] (built from the template by the app).
create function public.create_project(
  p_name text,
  p_client_name text,
  p_start date,
  p_end date,
  p_lead_id uuid default null,
  p_client_phone text default null,
  p_client_email text default null,
  p_site_address text default null,
  p_color text default 'emerald',
  p_area_sqft numeric default null,
  p_rate_per_sqft numeric default null,
  p_contract_value numeric default null,
  p_members jsonb default '[]'::jsonb,
  p_phases jsonb default '[]'::jsonb,
  p_mark_won boolean default true
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company uuid := private.current_company_id();
  v_prefix text;
  v_year text := to_char(private.ist_today(), 'YYYY');
  v_seq integer;
  v_project uuid;
  v_phase uuid;
  v_won uuid;
  m jsonb;
  ph jsonb;
  it jsonb;
  v_pos integer := 0;
  v_ipos integer;
begin
  if not private.is_admin() or not private.company_has('projects') then
    perform private.raise_forbidden();
  end if;
  if jsonb_typeof(coalesce(p_members, '[]')) <> 'array' or jsonb_array_length(coalesce(p_members, '[]')) > 30
     or jsonb_typeof(coalesce(p_phases, '[]')) <> 'array' or jsonb_array_length(coalesce(p_phases, '[]')) > 80 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_lead_id is not null then
    perform 1 from public.leads l where l.id = p_lead_id and l.company_id = v_company and l.archived_at is null for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.projects p where p.lead_id = p_lead_id) then
      raise exception 'project_exists' using errcode = '23505';
    end if;
  end if;

  -- Code: <initials>-<year>-<nnn>, numbered per company and year.
  perform pg_advisory_xact_lock(hashtextextended('project_code:' || v_company::text, 0));
  v_prefix := private.company_code_prefix(v_company);
  select coalesce(max(nullif(split_part(p.code, '-', 3), '')::integer), 0) + 1 into v_seq
  from public.projects p where p.company_id = v_company and p.code like v_prefix || '-' || v_year || '-%' and split_part(p.code, '-', 3) ~ '^\d+$';

  insert into public.projects (company_id, lead_id, code, name, client_name, client_phone, client_email, site_address,
    start_date, end_date, color, created_by)
  values (v_company, p_lead_id, v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 3, '0'), p_name, p_client_name,
    nullif(btrim(coalesce(p_client_phone, '')), ''), p_client_email, private.clean_label(p_site_address),
    p_start, p_end, coalesce(p_color, 'emerald'), v_uid)
  returning id into v_project;

  insert into public.project_financials (project_id, area_sqft, rate_per_sqft, contract_value, updated_by)
  values (v_project, p_area_sqft, p_rate_per_sqft, p_contract_value, v_uid);

  insert into public.project_activities (project_id, actor_id, type, meta)
  values (v_project, v_uid, 'project_created', jsonb_build_object('lead_id', p_lead_id, 'start', p_start, 'end', p_end,
    'phases', jsonb_array_length(coalesce(p_phases, '[]'))));

  for m in select * from jsonb_array_elements(coalesce(p_members, '[]')) loop
    if (m ->> 'role') not in ('architect_manager', 'landscape_designer', 'execution')
       or not private.user_has_role((m ->> 'user_id')::uuid, v_company, (m ->> 'role')::public.app_role) then
      raise exception 'invalid_member' using errcode = '22023';
    end if;
    insert into public.project_members (project_id, user_id, member_role, added_by)
    values (v_project, (m ->> 'user_id')::uuid, (m ->> 'role')::public.project_member_role, v_uid)
    on conflict do nothing;
  end loop;

  for ph in select * from jsonb_array_elements(coalesce(p_phases, '[]')) loop
    v_pos := v_pos + 1;
    insert into public.project_phases (project_id, position, category, name, color, owner_id, planned_start, deadline,
      needs_client_approval, created_by)
    values (v_project, v_pos, coalesce(ph ->> 'category', 'General'), ph ->> 'name', coalesce(ph ->> 'color', 'emerald'),
      nullif(ph ->> 'owner_id', '')::uuid, (ph ->> 'planned_start')::date, (ph ->> 'deadline')::date,
      coalesce((ph ->> 'needs_client_approval')::boolean, false), v_uid)
    returning id into v_phase;
    if jsonb_typeof(ph -> 'items') = 'array' then
      if jsonb_array_length(ph -> 'items') > 40 then
        raise exception 'invalid_input' using errcode = '22023';
      end if;
      v_ipos := 0;
      for it in select * from jsonb_array_elements(ph -> 'items') loop
        v_ipos := v_ipos + 1;
        insert into public.project_phase_items (phase_id, position, title, created_by)
        values (v_phase, v_ipos, it #>> '{}', v_uid);
      end loop;
    end if;
  end loop;

  if p_lead_id is not null then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (p_lead_id, v_uid, 'project_created', jsonb_build_object('project_id', v_project, 'name', p_name));
    if coalesce(p_mark_won, true) then
      select s.id into v_won from public.pipeline_stages s
      where s.company_id = v_company and s.kind = 'won' and s.archived_at is null order by s.position, s.id limit 1;
      update public.leads set stage_id = v_won where id = p_lead_id and status <> 'won' and v_won is not null;
    end if;
  end if;
  return v_project;
end $$;

-- Admin, or the project's architect manager (designers / execution only): add or remove a team member.
create function public.set_project_member(p_project_id uuid, p_user_id uuid, p_role public.project_member_role, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid;
begin
  if not private.can_manage_project(p_project_id) or p_role = 'client'
     or (not private.is_admin() and p_role = 'architect_manager') then
    perform private.raise_forbidden();
  end if;
  select p.company_id into v_company from public.projects p where p.id = p_project_id;
  if coalesce(p_on, false) then
    if not private.user_has_role(p_user_id, v_company, p_role::text::public.app_role) then
      raise exception 'invalid_member' using errcode = '22023';
    end if;
    insert into public.project_members (project_id, user_id, member_role, added_by)
    values (p_project_id, p_user_id, p_role, (select auth.uid()))
    on conflict do nothing;
    if found then
      perform private.log_project(p_project_id, 'member_added', jsonb_build_object('name', private.display_name(p_user_id), 'role', p_role));
    end if;
  else
    update public.project_members set removed_at = now(), removed_by = (select auth.uid())
    where project_id = p_project_id and user_id = p_user_id and member_role = p_role and removed_at is null;
    if found then
      perform private.log_project(p_project_id, 'member_removed', jsonb_build_object('name', private.display_name(p_user_id), 'role', p_role));
      -- Their open phases go back to unassigned unless they are still on the project in another role.
      if not exists (select 1 from public.project_members m where m.project_id = p_project_id and m.user_id = p_user_id and m.removed_at is null) then
        update public.project_phases set owner_id = null
        where project_id = p_project_id and owner_id = p_user_id and archived_at is null;
      end if;
    end if;
  end if;
end $$;

-- Admin / account: contract value and its calculation inputs.
create function public.set_project_financials(p_project_id uuid, p_area_sqft numeric, p_rate_per_sqft numeric, p_contract_value numeric)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.project_financials%rowtype;
begin
  if not private.can_see_project_money(p_project_id) then
    perform private.raise_forbidden();
  end if;
  select * into v_old from public.project_financials where project_id = p_project_id for update;
  insert into public.project_financials as f (project_id, area_sqft, rate_per_sqft, contract_value, updated_by)
  values (p_project_id, p_area_sqft, p_rate_per_sqft, p_contract_value, (select auth.uid()))
  on conflict (project_id) do update set area_sqft = excluded.area_sqft, rate_per_sqft = excluded.rate_per_sqft,
    contract_value = excluded.contract_value, updated_by = excluded.updated_by;
  if v_old.contract_value is distinct from p_contract_value then
    perform private.log_project(p_project_id, 'project_updated', jsonb_build_object('changes', jsonb_build_object(
      'Contract value', jsonb_build_object('from', v_old.contract_value, 'to', p_contract_value)), 'money', true));
  end if;
end $$;

create function public.add_project_note(p_project_id uuid, p_body text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.can_access_project(p_project_id) then
    perform private.raise_forbidden();
  end if;
  if private.clean_label(p_body) is null or char_length(p_body) > 5000 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  insert into public.project_activities (project_id, actor_id, type, body)
  values (p_project_id, (select auth.uid()), 'note', btrim(p_body))
  returning id into v_id;
  return v_id;
end $$;

-- Reorders phases (managers). p_ids is the new order of the project's phases.
create function public.reorder_project_phases(p_project_id uuid, p_ids uuid[])
returns void
language plpgsql security invoker set search_path = ''
as $$
begin
  if not private.can_manage_project(p_project_id) or cardinality(coalesce(p_ids, '{}')) > 200 then
    perform private.raise_forbidden();
  end if;
  update public.project_phases ph set position = x.n
  from unnest(p_ids) with ordinality as x(id, n)
  where ph.id = x.id and ph.project_id = p_project_id and ph.position is distinct from x.n::integer;
end $$;

-- Phase JSON for lists and details (derived lateness in IST days).
create function private.phase_json(ph public.project_phases)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', ph.id, 'position', ph.position, 'category', ph.category, 'name', ph.name, 'color', ph.color,
    'owner', case when ph.owner_id is null then null else jsonb_build_object('id', ph.owner_id, 'display_name', private.display_name(ph.owner_id)) end,
    'planned_start', ph.planned_start, 'deadline', ph.deadline, 'actual_start', ph.actual_start, 'submitted_on', ph.submitted_on,
    'status', ph.status, 'needs_client_approval', ph.needs_client_approval, 'notes', ph.notes, 'remark', ph.remark,
    'version', ph.version, 'updated_at', ph.updated_at,
    'late_days', case
      when ph.status = 'skipped' then 0
      when ph.submitted_on is not null and ph.status in ('in_review', 'done') then greatest(ph.submitted_on - ph.deadline, 0)
      else greatest(private.ist_today() - ph.deadline, 0) end,
    'overdue', ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < private.ist_today(),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'title', i.title, 'position', i.position,
        'done_at', i.done_at, 'done_by', private.display_name(i.done_by)) order by i.position, i.id)
      from public.project_phase_items i where i.phase_id = ph.id and i.archived_at is null), '[]'::jsonb)
  )
$$;

create function public.list_projects(
  p_search text default null,
  p_status text default 'open',
  p_member_id uuid default null,
  p_late_only boolean default false,
  p_sort text default 'end_date',
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_today date := private.ist_today();
  v_total bigint;
  v_items jsonb;
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('account') or private.has_role('architect_manager')
     or private.has_role('landscape_designer') or private.has_role('execution')) then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if p_status not in ('open', 'active', 'on_hold', 'completed', 'cancelled', 'all') or p_sort not in ('end_date', 'created', 'code', 'name') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;
  if not private.is_admin() then
    p_member_id := null;
  end if;

  with filtered as (
    select p.* from public.projects p
    where p.archived_at is null
      and case p_status when 'all' then true when 'open' then p.status in ('active', 'on_hold') else p.status::text = p_status end
      and (v_pattern is null or p.name ilike v_pattern or p.client_name ilike v_pattern or p.code ilike v_pattern
           or p.client_phone like '%' || nullif(regexp_replace(v_term, '\D', '', 'g'), '') || '%')
      and (p_member_id is null or exists (select 1 from public.project_members m
        where m.project_id = p.id and m.user_id = p_member_id and m.removed_at is null))
      and (not coalesce(p_late_only, false) or exists (select 1 from public.project_phases ph
        where ph.project_id = p.id and ph.archived_at is null and ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today))
  ), page as (
    select f.*, row_number() over (order by
      case when p_sort = 'end_date' then f.end_date end asc,
      case when p_sort = 'created' then f.created_at end desc,
      case when p_sort = 'code' then f.code end desc,
      case when p_sort = 'name' then lower(f.name) end asc,
      f.id) as rn
    from filtered f
    order by rn
    limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'code', pg.code, 'name', pg.name, 'client_name', pg.client_name, 'client_phone', pg.client_phone,
      'status', pg.status, 'color', pg.color, 'start_date', pg.start_date, 'end_date', pg.end_date, 'lead_id', pg.lead_id,
      'site_address', pg.site_address, 'updated_at', pg.updated_at,
      'phases_total', s.total, 'phases_done', s.done, 'late_phases', s.late, 'max_late_days', s.max_late,
      'current_phase', (select jsonb_build_object('id', ph.id, 'name', ph.name, 'category', ph.category, 'status', ph.status,
          'deadline', ph.deadline, 'color', ph.color)
        from public.project_phases ph
        where ph.project_id = pg.id and ph.archived_at is null and ph.status not in ('done', 'skipped')
        order by ph.planned_start, ph.position, ph.id limit 1),
      'team', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'display_name', pr.display_name, 'role', m.member_role)
          order by m.member_role, pr.display_name)
        from public.project_members m join public.profiles pr on pr.id = m.user_id
        where m.project_id = pg.id and m.removed_at is null and m.member_role <> 'client'), '[]'::jsonb)
    ) order by pg.rn), '[]'::jsonb)
    from page pg
    cross join lateral (
      select count(*) as total,
        count(*) filter (where ph.status in ('done', 'skipped')) as done,
        count(*) filter (where ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today) as late,
        coalesce(max(case when ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today then v_today - ph.deadline end), 0) as max_late
      from public.project_phases ph where ph.project_id = pg.id and ph.archived_at is null
    ) s)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.project_detail(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_p public.projects%rowtype;
  v_money boolean;
begin
  if not private.can_access_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_p from public.projects where id = p_project_id;
  v_money := private.can_see_project_money(p_project_id);
  return jsonb_build_object(
    'project', jsonb_build_object(
      'id', v_p.id, 'code', v_p.code, 'name', v_p.name, 'client_name', v_p.client_name, 'client_phone', v_p.client_phone,
      'client_email', v_p.client_email, 'site_address', v_p.site_address, 'site_lat', v_p.site_lat, 'site_lng', v_p.site_lng,
      'start_date', v_p.start_date, 'end_date', v_p.end_date, 'completed_on', v_p.completed_on, 'status', v_p.status,
      'color', v_p.color, 'storage_quota_bytes', v_p.storage_quota_bytes, 'version', v_p.version,
      'created_at', v_p.created_at, 'updated_at', v_p.updated_at, 'archived_at', v_p.archived_at,
      'created_by', private.display_name(v_p.created_by)),
    'financials', case when v_money then (
      select jsonb_build_object('area_sqft', f.area_sqft, 'rate_per_sqft', f.rate_per_sqft, 'contract_value', f.contract_value)
      from public.project_financials f where f.project_id = p_project_id) end,
    'lead', (select jsonb_build_object('id', l.id, 'name', l.name, 'owner', private.display_name(l.owner_id), 'handoff_note', l.handoff_note)
      from public.leads l where l.id = v_p.lead_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'display_name', pr.display_name, 'role', m.member_role,
        'added_at', m.added_at) order by m.member_role, pr.display_name)
      from public.project_members m join public.profiles pr on pr.id = m.user_id
      where m.project_id = p_project_id and m.removed_at is null and m.member_role <> 'client'), '[]'::jsonb),
    'phases', coalesce((select jsonb_agg(private.phase_json(ph) order by ph.position, ph.id)
      from public.project_phases ph where ph.project_id = p_project_id and ph.archived_at is null), '[]'::jsonb),
    'can', jsonb_build_object('manage', private.can_manage_project(p_project_id), 'money', v_money, 'admin', private.is_admin())
  );
end $$;

create function public.list_project_activities(p_project_id uuid, p_limit integer default 30, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_money boolean;
begin
  if not private.can_access_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  v_money := private.can_see_project_money(p_project_id);
  return (
    with page as (
      select a.* from public.project_activities a
      where a.project_id = p_project_id and (v_money or not coalesce((a.meta ->> 'money')::boolean, false))
      order by a.created_at desc, a.id desc
      limit p_limit + 1 offset p_offset
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'type', x.type, 'body', x.body, 'meta', x.meta,
          'phase_id', x.phase_id, 'created_at', x.created_at,
          'actor', case when x.actor_id is null then null else jsonb_build_object('display_name', private.display_name(x.actor_id)) end)
        order by x.created_at desc, x.id desc) from (select * from page order by created_at desc, id desc limit p_limit) x), '[]'::jsonb),
      'has_more', (select count(*) from page) > p_limit)
  );
end $$;

-- People who can join projects in a role (for the assignment pickers).
create function public.project_role_people(p_role public.app_role)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('architect_manager')) then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name) order by lower(p.display_name), p.id), '[]'::jsonb)
    from public.profiles p
    where p.company_id = private.current_company_id() and p.is_active and (p.role = p_role or p_role = any(p.extra_roles))
  );
end $$;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.projects, public.project_members, public.project_activities, public.project_phases, public.project_phase_items;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.can_access_project(uuid),
  private.can_manage_project(uuid),
  private.can_see_project_money(uuid),
  private.user_has_role(uuid, uuid, public.app_role),
  private.log_project(uuid, text, jsonb, uuid, text),
  private.projects_before_write(),
  private.projects_after_write(),
  private.project_phases_before_write(),
  private.project_phases_after_write(),
  private.project_phase_items_before_write(),
  private.company_code_prefix(uuid),
  private.phase_json(public.project_phases),
  public.handoff_lead(uuid, text),
  public.list_handoff_leads(integer),
  public.create_project(text, text, date, date, uuid, text, text, text, text, numeric, numeric, numeric, jsonb, jsonb, boolean),
  public.set_project_member(uuid, uuid, public.project_member_role, boolean),
  public.set_project_financials(uuid, numeric, numeric, numeric),
  public.add_project_note(uuid, text),
  public.reorder_project_phases(uuid, uuid[]),
  public.list_projects(text, text, uuid, boolean, text, integer, integer),
  public.project_detail(uuid),
  public.list_project_activities(uuid, integer, integer),
  public.project_role_people(public.app_role)
from public, anon, authenticated;

grant execute on function
  private.can_access_project(uuid),
  private.can_manage_project(uuid),
  private.can_see_project_money(uuid)
to authenticated, service_role;
grant execute on function
  public.handoff_lead(uuid, text),
  public.list_handoff_leads(integer),
  public.create_project(text, text, date, date, uuid, text, text, text, text, numeric, numeric, numeric, jsonb, jsonb, boolean),
  public.set_project_member(uuid, uuid, public.project_member_role, boolean),
  public.set_project_financials(uuid, numeric, numeric, numeric),
  public.add_project_note(uuid, text),
  public.reorder_project_phases(uuid, uuid[]),
  public.list_projects(text, text, uuid, boolean, text, integer, integer),
  public.project_detail(uuid),
  public.list_project_activities(uuid, integer, integer),
  public.project_role_people(public.app_role)
to authenticated;
