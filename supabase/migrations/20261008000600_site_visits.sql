-- ---------------------------------------------------------------------------
-- Site visits (projects module): before a project (a lead's site, by the BDM or the
-- architect manager) and during one. Check-in captures the phone's GPS position and how
-- far it is from the saved site pin; the first visit can set the pin.
-- ---------------------------------------------------------------------------
create table public.site_visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null default private.current_company_id() references public.companies (id),
  project_id uuid references public.projects (id) on delete cascade,
  lead_id uuid references public.leads (id),
  assigned_to uuid not null references public.profiles (id),
  scheduled_at timestamptz not null,
  purpose text not null default 'Site visit' check (char_length(btrim(purpose)) between 1 and 200),
  status text not null default 'scheduled' check (status in ('scheduled', 'checked_in', 'completed', 'cancelled')),
  check_in_at timestamptz,
  check_in_lat numeric(9, 6) check (check_in_lat is null or check_in_lat between -90 and 90),
  check_in_lng numeric(9, 6) check (check_in_lng is null or check_in_lng between -180 and 180),
  check_in_accuracy_m numeric(8, 1) check (check_in_accuracy_m is null or check_in_accuracy_m >= 0),
  distance_from_site_m integer,
  check_out_at timestamptz,
  notes jsonb check (notes is null or (jsonb_typeof(notes) = 'object' and pg_column_size(notes) <= 200000)),
  measurements text check (measurements is null or char_length(measurements) <= 2000),
  outcome text check (outcome is null or char_length(outcome) <= 1000),
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (num_nonnulls(project_id, lead_id) >= 1)
);
create index site_visits_assignee_idx on public.site_visits (assigned_to, scheduled_at) where status in ('scheduled', 'checked_in');
create index site_visits_company_idx on public.site_visits (company_id, scheduled_at desc);
create index site_visits_project_idx on public.site_visits (project_id, scheduled_at desc) where project_id is not null;
create index site_visits_lead_idx on public.site_visits (lead_id, scheduled_at desc) where lead_id is not null;

-- Who may run a visit: staff with a site role in the company.
create function private.can_visit_sites(p_user_id uuid, p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.is_active and (p.company_id = p_company_id or p.role = 'super_admin')
      and (p.role in ('admin', 'super_admin', 'sales', 'architect_manager', 'landscape_designer')
           or p.extra_roles && array['admin', 'sales', 'architect_manager', 'landscape_designer']::public.app_role[]))
$$;

-- Can the signed-in user see this visit's lead or project (besides being the visitor)?
create function private.can_access_visit_target(p_project_id uuid, p_lead_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.company_has('projects') and (
    (p_project_id is not null and private.can_access_project(p_project_id))
    or (p_lead_id is not null and private.can_access_lead(p_lead_id)))
$$;

create function private.can_plan_visit(p_project_id uuid, p_lead_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.company_has('projects') and (
    (p_project_id is not null and private.can_manage_project(p_project_id))
    or (p_lead_id is not null and private.can_access_lead(p_lead_id))
    or private.is_admin())
$$;

-- Great-circle distance in metres.
create function private.distance_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns integer
language sql immutable set search_path = ''
as $$
  select round(2 * 6371000 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::float8) / 2), 2)
    + cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * power(sin(radians((lng2 - lng1)::float8) / 2), 2))))::integer
$$;

create trigger site_visits_company_guard before insert or update or delete on public.site_visits
  for each row execute function private.company_guard();

create function private.site_visits_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.purpose := coalesce(private.clean_label(new.purpose), 'Site visit');
  new.measurements := nullif(btrim(coalesce(new.measurements, '')), '');
  new.outcome := nullif(btrim(coalesce(new.outcome, '')), '');
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce(v_uid, new.created_by);
    new.created_at := now();
    new.status := 'scheduled';
    new.check_in_at := null;
    new.check_out_at := null;
    -- A project visit carries the project's lead too, so the lead's timeline can show it.
    if new.project_id is not null then
      new.lead_id := coalesce(new.lead_id, (select p.lead_id from public.projects p where p.id = new.project_id));
    end if;
  else
    new.id := old.id;
    new.company_id := old.company_id;
    new.project_id := old.project_id;
    new.lead_id := old.lead_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    -- Location is only written by the check-in RPC (definer, no user session check here).
    if v_uid is not null and current_setting('crm.site_check_in', true) is distinct from 'on' and (
      new.check_in_lat is distinct from old.check_in_lat or new.check_in_lng is distinct from old.check_in_lng
      or new.check_in_at is distinct from old.check_in_at or new.distance_from_site_m is distinct from old.distance_from_site_m) then
      perform private.raise_forbidden();
    end if;
    if new.status = 'completed' and old.status <> 'completed' then
      new.check_out_at := coalesce(new.check_out_at, now());
    end if;
  end if;
  new.updated_at := now();
  if (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and not private.can_visit_sites(new.assigned_to, new.company_id) then
    raise exception 'invalid_visitor' using errcode = '22023';
  end if;
  if new.lead_id is not null and not exists (select 1 from public.leads l where l.id = new.lead_id and l.company_id = new.company_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return new;
end $$;

create trigger site_visits_before_write before insert or update on public.site_visits
  for each row execute function private.site_visits_before_write();

alter table public.site_visits enable row level security;
create policy site_visits_select on public.site_visits for select to authenticated
  using (company_id = (select private.current_company_id()) and (
    assigned_to = (select auth.uid()) or (select private.is_admin())
    or (select private.can_access_visit_target(project_id, lead_id))));
create policy site_visits_insert on public.site_visits for insert to authenticated
  with check ((select private.can_plan_visit(project_id, lead_id)));
create policy site_visits_update on public.site_visits for update to authenticated
  using (company_id = (select private.current_company_id()) and (
    assigned_to = (select auth.uid()) or (select private.can_plan_visit(project_id, lead_id))))
  with check (company_id = (select private.current_company_id()));

revoke all on public.site_visits from anon, authenticated;
grant select on public.site_visits to authenticated;
grant insert (project_id, lead_id, assigned_to, scheduled_at, purpose, notes, measurements) on public.site_visits to authenticated;
grant update (assigned_to, scheduled_at, purpose, status, notes, measurements, outcome) on public.site_visits to authenticated;

-- Project feed events for visits.
alter table public.project_activities drop constraint project_activities_type_check;
alter table public.project_activities add constraint project_activities_type_check check (type in (
  'project_created', 'project_updated', 'status_changed', 'member_added', 'member_removed', 'note',
  'phase_added', 'phase_updated', 'phase_rescheduled', 'phase_status_changed', 'phase_owner_changed', 'phase_removed',
  'payment_recorded', 'payment_updated', 'payment_removed', 'schedule_changed',
  'visit_scheduled', 'visit_checked_in', 'visit_completed', 'visit_cancelled'));

create function private.site_visits_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text;
begin
  if new.project_id is null then
    return null;
  end if;
  v_type := case
    when tg_op = 'INSERT' then 'visit_scheduled'
    when new.status is distinct from old.status then case new.status
      when 'checked_in' then 'visit_checked_in' when 'completed' then 'visit_completed' when 'cancelled' then 'visit_cancelled' end
    when new.scheduled_at is distinct from old.scheduled_at or new.assigned_to is distinct from old.assigned_to then 'visit_scheduled'
  end;
  if v_type is not null then
    perform private.log_project(new.project_id, v_type, jsonb_strip_nulls(jsonb_build_object(
      'visit_id', new.id, 'purpose', new.purpose, 'at', new.scheduled_at, 'visitor', private.display_name(new.assigned_to),
      'distance_m', case when v_type = 'visit_checked_in' then new.distance_from_site_m end,
      'outcome', case when v_type = 'visit_completed' then new.outcome end)));
  end if;
  return null;
end $$;

create trigger site_visits_after_write after insert or update on public.site_visits
  for each row execute function private.site_visits_after_write();

-- The visitor (or a manager) checks in with the phone's position. With p_set_pin and no pin
-- yet, the position becomes the project's site pin.
create function public.site_visit_check_in(p_visit_id uuid, p_lat numeric, p_lng numeric, p_accuracy numeric, p_set_pin boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.site_visits%rowtype;
  v_project public.projects%rowtype;
  v_distance integer;
  v_pinned boolean := false;
begin
  select * into v from public.site_visits where id = p_visit_id for update;
  if not found or v.company_id is distinct from private.current_company_id() or not private.company_has('projects')
     or not (v.assigned_to = (select auth.uid()) or private.can_plan_visit(v.project_id, v.lead_id)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.status not in ('scheduled', 'checked_in') then
    raise exception 'visit_closed' using errcode = '22023';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid_location' using errcode = '22023';
  end if;
  if v.project_id is not null then
    select * into v_project from public.projects where id = v.project_id for update;
    if v_project.site_lat is not null then
      v_distance := private.distance_m(v_project.site_lat, v_project.site_lng, p_lat, p_lng);
    elsif coalesce(p_set_pin, false) then
      update public.projects set site_lat = round(p_lat, 6), site_lng = round(p_lng, 6) where id = v.project_id;
      v_distance := 0;
      v_pinned := true;
    end if;
  end if;
  perform set_config('crm.site_check_in', 'on', true);
  update public.site_visits set status = 'checked_in', check_in_at = now(), check_in_lat = round(p_lat, 6), check_in_lng = round(p_lng, 6),
    check_in_accuracy_m = round(greatest(coalesce(p_accuracy, 0), 0), 1), distance_from_site_m = v_distance
  where id = p_visit_id;
  perform set_config('crm.site_check_in', 'off', true);
  return jsonb_build_object('distance_m', v_distance, 'pinned', v_pinned);
end $$;

create function private.site_visit_json(v public.site_visits)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', v.id, 'project_id', v.project_id, 'lead_id', v.lead_id, 'scheduled_at', v.scheduled_at, 'purpose', v.purpose,
    'status', v.status, 'check_in_at', v.check_in_at, 'check_in_lat', v.check_in_lat, 'check_in_lng', v.check_in_lng,
    'check_in_accuracy_m', v.check_in_accuracy_m, 'distance_from_site_m', v.distance_from_site_m, 'check_out_at', v.check_out_at,
    'notes', v.notes, 'measurements', v.measurements, 'outcome', v.outcome, 'version', v.version, 'created_at', v.created_at,
    'assignee', jsonb_build_object('id', v.assigned_to, 'display_name', private.display_name(v.assigned_to)),
    'project', (select jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'site_address', p.site_address,
        'site_lat', p.site_lat, 'site_lng', p.site_lng, 'client_name', p.client_name, 'client_phone', p.client_phone)
      from public.projects p where p.id = v.project_id),
    'lead', (select jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone) from public.leads l where l.id = v.lead_id),
    'overdue', v.status = 'scheduled' and v.scheduled_at < now() - interval '2 hours')
$$;

-- Today / upcoming / past visits the user may see; "mine" limits to the visitor's own.
create function public.list_site_visits(
  p_view text default 'upcoming',
  p_mine boolean default false,
  p_project_id uuid default null,
  p_lead_id uuid default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_total bigint;
  v_items jsonb;
begin
  if not private.company_has('projects') then
    perform private.raise_forbidden();
  end if;
  if p_view not in ('today', 'upcoming', 'past', 'all') then
    raise exception 'invalid_view' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  with f as (
    select v.* from public.site_visits v
    where (not coalesce(p_mine, false) or v.assigned_to = (select auth.uid()))
      and (p_project_id is null or v.project_id = p_project_id)
      and (p_lead_id is null or v.lead_id = p_lead_id)
      and case p_view
        when 'today' then (v.status <> 'cancelled' and v.scheduled_at >= v_today and v.scheduled_at < v_today + interval '1 day')
          or v.status = 'checked_in'
        when 'upcoming' then v.status in ('scheduled', 'checked_in')
        when 'past' then v.status in ('completed', 'cancelled')
        else true end
  ), page as (
    select f.id, row_number() over (order by
      case when p_view = 'past' then f.scheduled_at end desc,
      case when p_view <> 'past' then f.scheduled_at end asc, f.id) as rn
    from f order by rn limit p_limit offset p_offset
  )
  select (select count(*) from f), coalesce((select jsonb_agg(private.site_visit_json(v) order by pg.rn)
      from page pg join public.site_visits v on v.id = pg.id), '[]'::jsonb)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- People who can be sent on a visit (for the scheduling picker).
create function public.site_visit_people()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.company_has('projects') or not private.is_lead_user() and not private.has_role('architect_manager') then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role) order by lower(p.display_name), p.id), '[]'::jsonb)
    from public.profiles p
    where p.company_id = private.current_company_id() and private.can_visit_sites(p.id, p.company_id)
  );
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.site_visits;
  end if;
end $$;

revoke all on function
  private.can_visit_sites(uuid, uuid),
  private.can_access_visit_target(uuid, uuid),
  private.can_plan_visit(uuid, uuid),
  private.distance_m(numeric, numeric, numeric, numeric),
  private.site_visits_before_write(),
  private.site_visits_after_write(),
  private.site_visit_json(public.site_visits),
  public.site_visit_check_in(uuid, numeric, numeric, numeric, boolean),
  public.list_site_visits(text, boolean, uuid, uuid, integer, integer),
  public.site_visit_people()
from public, anon, authenticated;

grant execute on function private.can_access_visit_target(uuid, uuid), private.can_plan_visit(uuid, uuid), private.site_visit_json(public.site_visits)
  to authenticated, service_role;
grant execute on function
  public.site_visit_check_in(uuid, numeric, numeric, numeric, boolean),
  public.list_site_visits(text, boolean, uuid, uuid, integer, integer),
  public.site_visit_people()
to authenticated;
