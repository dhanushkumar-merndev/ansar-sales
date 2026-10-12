-- ---------------------------------------------------------------------------
-- Client payments in parts (Accounts): a payment schedule per project
-- (Advance 30% → 20% after design → 30% after BOQ R2 → 20% at handover, editable)
-- and the payments actually received (mode, reference, who received it).
--
-- Money is visible to admin and account only. Architect managers get the schedule's
-- status (paid / due / overdue) without amounts through project_payment_status().
-- A milestone is due on its date, or when its linked phase is done; it is overdue a week
-- after that while not fully paid. Status is derived, never stored.
-- Amounts are numeric rupees, never floating point.
-- ---------------------------------------------------------------------------

create table public.project_payment_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  position integer not null default 0,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  percent numeric(5, 2) check (percent is null or (percent > 0 and percent <= 100)),
  amount numeric(14, 2) not null check (amount >= 0),
  due_trigger text not null default 'date' check (due_trigger in ('date', 'phase')),
  due_date date,
  phase_id uuid references public.project_phases (id) on delete set null,
  notes text check (notes is null or char_length(notes) <= 500),
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check (due_trigger <> 'date' or due_date is not null)
);
create index project_payment_milestones_project_idx on public.project_payment_milestones (project_id, position) where archived_at is null;
create index project_payment_milestones_due_idx on public.project_payment_milestones (due_date) where archived_at is null;

create table public.project_payments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  milestone_id uuid references public.project_payment_milestones (id) on delete set null,
  amount numeric(14, 2) not null check (amount > 0),
  paid_on date not null,
  mode text not null check (mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  reference text check (reference is null or char_length(reference) <= 120),
  received_by uuid references public.profiles (id),
  notes text check (notes is null or char_length(notes) <= 1000),
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);
create index project_payments_project_idx on public.project_payments (project_id, paid_on desc) where archived_at is null;
create index project_payments_paid_on_idx on public.project_payments (paid_on) where archived_at is null;
create index project_payments_milestone_idx on public.project_payments (milestone_id) where archived_at is null;

-- Payment events in the project feed (hidden from non-money roles by list_project_activities).
alter table public.project_activities drop constraint project_activities_type_check;
alter table public.project_activities add constraint project_activities_type_check check (type in (
  'project_created', 'project_updated', 'status_changed', 'member_added', 'member_removed', 'note',
  'phase_added', 'phase_updated', 'phase_rescheduled', 'phase_status_changed', 'phase_owner_changed', 'phase_removed',
  'payment_recorded', 'payment_updated', 'payment_removed', 'schedule_changed'));

-- ---------------------------------------------------------------------------
-- Derived status
-- ---------------------------------------------------------------------------
-- When a milestone falls due: its date, or the day its linked phase was finished.
create function private.milestone_due_on(m public.project_payment_milestones)
returns date
language sql stable security definer set search_path = ''
as $$
  select case m.due_trigger
    when 'date' then m.due_date
    else (select case when ph.status = 'done' then coalesce(ph.submitted_on, (ph.updated_at at time zone 'Asia/Kolkata')::date) end
          from public.project_phases ph where ph.id = m.phase_id and ph.archived_at is null) end
$$;

create function private.milestone_json(m public.project_payment_milestones, p_money boolean)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with x as (
    select coalesce((select sum(p.amount) from public.project_payments p where p.milestone_id = m.id and p.archived_at is null), 0) as paid,
      private.milestone_due_on(m) as due_on,
      private.ist_today() as today
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'id', m.id, 'position', m.position, 'label', m.label, 'due_trigger', m.due_trigger, 'due_date', m.due_date,
    'phase', (select jsonb_build_object('id', ph.id, 'name', ph.name, 'status', ph.status) from public.project_phases ph where ph.id = m.phase_id),
    'due_on', x.due_on, 'version', m.version,
    'status', case
      when m.amount > 0 and x.paid >= m.amount then 'paid'
      when x.due_on is not null and x.due_on < x.today - 7 then 'overdue'
      when x.paid > 0 then 'partly_paid'
      when x.due_on is not null and x.due_on <= x.today then 'due'
      else 'upcoming' end,
    'days_overdue', case when x.paid < m.amount and x.due_on is not null and x.due_on < x.today then x.today - x.due_on end,
    'percent', case when p_money then m.percent end,
    'amount', case when p_money then m.amount end,
    'paid', case when p_money then x.paid end,
    'balance', case when p_money then greatest(m.amount - x.paid, 0) end,
    'notes', case when p_money then m.notes end))
  from x
$$;

-- ---------------------------------------------------------------------------
-- Triggers: audit into the project feed (money events are flagged so the team never sees them)
-- ---------------------------------------------------------------------------
create function private.project_payments_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.reference := private.clean_label(new.reference);
  new.notes := nullif(btrim(coalesce(new.notes, '')), '');
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce(v_uid, new.created_by);
    new.received_by := coalesce(new.received_by, v_uid);
    new.created_at := now();
    new.updated_at := now();
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    new.updated_at := now();
    if new.archived_at is distinct from old.archived_at then
      new.archived_by := case when new.archived_at is null then null else v_uid end;
    end if;
  end if;
  if new.milestone_id is not null and not exists (
    select 1 from public.project_payment_milestones m where m.id = new.milestone_id and m.project_id = new.project_id
  ) then
    raise exception 'milestone_not_found' using errcode = 'P0002';
  end if;
  if new.received_by is not null and not exists (
    select 1 from public.profiles p join public.projects pr on pr.id = new.project_id
    where p.id = new.received_by and (p.company_id = pr.company_id or p.role = 'super_admin')
  ) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger project_payments_before_write before insert or update on public.project_payments
  for each row execute function private.project_payments_before_write();

create function private.project_payments_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_label text := (select m.label from public.project_payment_milestones m where m.id = new.milestone_id);
begin
  if tg_op = 'INSERT' then
    perform private.log_project(new.project_id, 'payment_recorded', jsonb_build_object('money', true, 'amount', new.amount,
      'mode', new.mode, 'paid_on', new.paid_on, 'milestone', v_label, 'reference', new.reference));
  elsif new.archived_at is distinct from old.archived_at then
    perform private.log_project(new.project_id, 'payment_removed', jsonb_build_object('money', true, 'amount', new.amount,
      'paid_on', new.paid_on, 'milestone', v_label, 'restored', new.archived_at is null));
  elsif (new.amount, new.paid_on, new.mode, new.milestone_id, new.reference) is distinct from (old.amount, old.paid_on, old.mode, old.milestone_id, old.reference) then
    perform private.log_project(new.project_id, 'payment_updated', jsonb_build_object('money', true,
      'from', jsonb_build_object('amount', old.amount, 'paid_on', old.paid_on, 'mode', old.mode),
      'to', jsonb_build_object('amount', new.amount, 'paid_on', new.paid_on, 'mode', new.mode), 'milestone', v_label));
  end if;
  return null;
end $$;

create trigger project_payments_after_write after insert or update on public.project_payments
  for each row execute function private.project_payments_after_write();

create function private.project_milestones_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.label := btrim(new.label);
  new.notes := private.clean_label(new.notes);
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  if new.due_trigger = 'phase' and (new.phase_id is null or not exists (
    select 1 from public.project_phases ph where ph.id = new.phase_id and ph.project_id = new.project_id)) then
    raise exception 'phase_required' using errcode = '22023';
  end if;
  if new.due_trigger = 'date' then
    new.phase_id := null;
  end if;
  return new;
end $$;

create trigger project_milestones_before_write before insert or update on public.project_payment_milestones
  for each row execute function private.project_milestones_before_write();

create function private.project_milestones_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  -- Template milestones made with the project are part of "project created".
  if tg_op = 'INSERT' and not exists (select 1 from public.project_activities a where a.project_id = new.project_id and a.type = 'project_created') then
    return null;
  end if;
  perform private.log_project(new.project_id, 'schedule_changed', jsonb_build_object('money', true, 'milestone', new.label,
    'amount', new.amount, 'action', case when tg_op = 'INSERT' then 'added'
      when new.archived_at is not null and old.archived_at is null then 'removed' else 'changed' end));
  return null;
end $$;

create trigger project_milestones_after_write after insert or update on public.project_payment_milestones
  for each row execute function private.project_milestones_after_write();

-- ---------------------------------------------------------------------------
-- RLS: admin and account only
-- ---------------------------------------------------------------------------
alter table public.project_payment_milestones enable row level security;
alter table public.project_payments enable row level security;

create policy project_payment_milestones_select on public.project_payment_milestones for select to authenticated
  using ((select private.can_see_project_money(project_id)));
create policy project_payment_milestones_insert on public.project_payment_milestones for insert to authenticated
  with check ((select private.can_see_project_money(project_id)));
create policy project_payment_milestones_update on public.project_payment_milestones for update to authenticated
  using ((select private.can_see_project_money(project_id))) with check ((select private.can_see_project_money(project_id)));

create policy project_payments_select on public.project_payments for select to authenticated
  using ((select private.can_see_project_money(project_id)));
create policy project_payments_insert on public.project_payments for insert to authenticated
  with check ((select private.can_see_project_money(project_id)));
create policy project_payments_update on public.project_payments for update to authenticated
  using ((select private.can_see_project_money(project_id))) with check ((select private.can_see_project_money(project_id)));

revoke all on public.project_payment_milestones, public.project_payments from anon, authenticated;
grant select on public.project_payment_milestones, public.project_payments to authenticated;
grant insert (project_id, position, label, percent, amount, due_trigger, due_date, phase_id, notes)
  on public.project_payment_milestones to authenticated;
grant update (position, label, percent, amount, due_trigger, due_date, phase_id, notes, archived_at)
  on public.project_payment_milestones to authenticated;
grant insert (project_id, milestone_id, amount, paid_on, mode, reference, received_by, notes) on public.project_payments to authenticated;
grant update (milestone_id, amount, paid_on, mode, reference, received_by, notes, archived_at) on public.project_payments to authenticated;

-- ---------------------------------------------------------------------------
-- Project creation now also makes the payment schedule.
-- p_milestones: [{label, percent?, amount, due_trigger: 'date'|'phase', due_date?, phase_index?}]
-- (phase_index is the 1-based position in p_phases).
-- ---------------------------------------------------------------------------
drop function public.create_project(text, text, date, date, uuid, text, text, text, text, numeric, numeric, numeric, jsonb, jsonb, boolean);
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
  p_mark_won boolean default true,
  p_milestones jsonb default '[]'::jsonb
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
  v_phase_ids uuid[] := '{}';
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
     or jsonb_typeof(coalesce(p_phases, '[]')) <> 'array' or jsonb_array_length(coalesce(p_phases, '[]')) > 80
     or jsonb_typeof(coalesce(p_milestones, '[]')) <> 'array' or jsonb_array_length(coalesce(p_milestones, '[]')) > 20 then
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

  -- Members, phases and the schedule first, then the "created" event (their own triggers stay quiet before it).
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
    v_phase_ids := v_phase_ids || v_phase;
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

  v_pos := 0;
  for m in select * from jsonb_array_elements(coalesce(p_milestones, '[]')) loop
    v_pos := v_pos + 1;
    insert into public.project_payment_milestones (project_id, position, label, percent, amount, due_trigger, due_date, phase_id, created_by)
    values (v_project, v_pos, m ->> 'label', nullif(m ->> 'percent', '')::numeric, coalesce(nullif(m ->> 'amount', '')::numeric, 0),
      coalesce(m ->> 'due_trigger', 'date'), nullif(m ->> 'due_date', '')::date,
      case when m ->> 'due_trigger' = 'phase' then v_phase_ids[(m ->> 'phase_index')::integer] end, v_uid);
  end loop;

  insert into public.project_activities (project_id, actor_id, type, meta)
  values (v_project, v_uid, 'project_created', jsonb_build_object('lead_id', p_lead_id, 'start', p_start, 'end', p_end,
    'phases', jsonb_array_length(coalesce(p_phases, '[]'))));

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

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------
-- Money roles: the whole picture. Architect managers (on the project): status only.
create function public.project_payment_status(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_money boolean;
  v_value numeric;
begin
  if not private.can_access_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_money := private.can_see_project_money(p_project_id);
  if not v_money and not private.can_manage_project(p_project_id) then
    perform private.raise_forbidden();
  end if;
  select f.contract_value into v_value from public.project_financials f where f.project_id = p_project_id;
  return jsonb_build_object(
    'money', v_money,
    'contract_value', case when v_money then v_value end,
    'scheduled', case when v_money then (select coalesce(sum(m.amount), 0) from public.project_payment_milestones m
      where m.project_id = p_project_id and m.archived_at is null) end,
    'received', case when v_money then (select coalesce(sum(p.amount), 0) from public.project_payments p
      where p.project_id = p_project_id and p.archived_at is null) end,
    'milestones', coalesce((select jsonb_agg(private.milestone_json(m, v_money) order by m.position, m.id)
      from public.project_payment_milestones m where m.project_id = p_project_id and m.archived_at is null), '[]'::jsonb),
    'payments', case when v_money then coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'amount', p.amount, 'paid_on', p.paid_on, 'mode', p.mode, 'reference', p.reference, 'notes', p.notes,
        'milestone_id', p.milestone_id, 'milestone', (select m.label from public.project_payment_milestones m where m.id = p.milestone_id),
        'received_by', private.display_name(p.received_by), 'version', p.version, 'created_at', p.created_at)
        order by p.paid_on desc, p.created_at desc)
      from public.project_payments p where p.project_id = p_project_id and p.archived_at is null), '[]'::jsonb) end
  );
end $$;

-- Accounts: milestones across projects by view (due now, overdue, upcoming, paid) with paging.
create function public.list_payment_dues(
  p_view text default 'due',
  p_search text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_company uuid := private.current_company_id();
  v_total bigint;
  v_items jsonb;
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('account')) then
    perform private.raise_forbidden();
  end if;
  if p_view not in ('due', 'overdue', 'upcoming', 'paid', 'open') then
    raise exception 'invalid_view' using errcode = '22023';
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
  with ms as (
    select m.*, private.milestone_json(m, true) as j, pr.name as project_name, pr.code, pr.client_name, pr.client_phone
    from public.project_payment_milestones m
    join public.projects pr on pr.id = m.project_id and pr.company_id = v_company and pr.archived_at is null and pr.status <> 'cancelled'
    where m.archived_at is null
      and (v_pattern is null or pr.name ilike v_pattern or pr.client_name ilike v_pattern or pr.code ilike v_pattern or m.label ilike v_pattern)
  ), filtered as (
    select * from ms where case p_view
      when 'due' then ms.j ->> 'status' in ('due', 'partly_paid', 'overdue') and (ms.j ->> 'due_on') is not null
      when 'overdue' then ms.j ->> 'status' = 'overdue'
      when 'upcoming' then ms.j ->> 'status' = 'upcoming'
      when 'paid' then ms.j ->> 'status' = 'paid'
      else ms.j ->> 'status' <> 'paid' end
  ), page as (
    select f.*, row_number() over (order by (f.j ->> 'due_on')::date nulls last, f.due_date nulls last, f.code, f.position, f.id) as rn
    from filtered f order by rn limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    coalesce((select jsonb_agg(pg.j || jsonb_build_object('project', jsonb_build_object('id', pg.project_id, 'name', pg.project_name,
      'code', pg.code, 'client_name', pg.client_name, 'client_phone', pg.client_phone)) order by pg.rn) from page pg), '[]'::jsonb)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- Accounts: payments received in a date range across projects (newest first), with the range total.
create function public.list_payments_received(p_from date, p_to date, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('account')) then
    perform private.raise_forbidden();
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100
     or p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  return (
    with f as (
      select p.*, pr.name as project_name, pr.code from public.project_payments p
      join public.projects pr on pr.id = p.project_id and pr.company_id = v_company
      where p.archived_at is null and p.paid_on between p_from and p_to
    )
    select jsonb_build_object(
      'total', (select count(*) from f),
      'sum', (select coalesce(sum(amount), 0) from f),
      'by_mode', coalesce((select jsonb_object_agg(mode, s) from (select mode, sum(amount) as s from f group by mode) x), '{}'::jsonb),
      'items', coalesce((select jsonb_agg(x order by x.paid_on desc, x.created_at desc, x.id) from (
        select f.id, f.amount, f.paid_on, f.mode, f.reference, f.created_at,
          (select m.label from public.project_payment_milestones m where m.id = f.milestone_id) as milestone,
          private.display_name(f.received_by) as received_by,
          jsonb_build_object('id', f.project_id, 'name', f.project_name, 'code', f.code) as project
        from f order by f.paid_on desc, f.created_at desc, f.id limit p_limit offset p_offset) x), '[]'::jsonb))
  );
end $$;

-- Accounts dashboard numbers.
create function public.payments_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_today date := private.ist_today();
  v_month date := date_trunc('month', private.ist_today())::date;
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('account')) then
    perform private.raise_forbidden();
  end if;
  return (
    with ms as (
      select private.milestone_json(m, true) as j from public.project_payment_milestones m
      join public.projects pr on pr.id = m.project_id and pr.company_id = v_company and pr.archived_at is null and pr.status <> 'cancelled'
      where m.archived_at is null
    )
    select jsonb_build_object(
      'collected_month', (select coalesce(sum(p.amount), 0) from public.project_payments p join public.projects pr on pr.id = p.project_id
        where pr.company_id = v_company and p.archived_at is null and p.paid_on >= v_month and p.paid_on <= v_today),
      'collected_total', (select coalesce(sum(p.amount), 0) from public.project_payments p join public.projects pr on pr.id = p.project_id
        where pr.company_id = v_company and p.archived_at is null),
      'due_amount', (select coalesce(sum((j ->> 'balance')::numeric), 0) from ms where j ->> 'status' in ('due', 'partly_paid') and (j ->> 'due_on') is not null),
      'due_count', (select count(*) from ms where j ->> 'status' in ('due', 'partly_paid') and (j ->> 'due_on') is not null),
      'overdue_amount', (select coalesce(sum((j ->> 'balance')::numeric), 0) from ms where j ->> 'status' = 'overdue'),
      'overdue_count', (select count(*) from ms where j ->> 'status' = 'overdue'),
      'contract_total', (select coalesce(sum(f.contract_value), 0) from public.project_financials f join public.projects pr on pr.id = f.project_id
        where pr.company_id = v_company and pr.archived_at is null and pr.status <> 'cancelled')
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Realtime + privileges
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.project_payment_milestones, public.project_payments, public.project_financials;
  end if;
end $$;

revoke all on function
  private.milestone_due_on(public.project_payment_milestones),
  private.milestone_json(public.project_payment_milestones, boolean),
  private.project_payments_before_write(),
  private.project_payments_after_write(),
  private.project_milestones_before_write(),
  private.project_milestones_after_write(),
  public.create_project(text, text, date, date, uuid, text, text, text, text, numeric, numeric, numeric, jsonb, jsonb, boolean, jsonb),
  public.project_payment_status(uuid),
  public.list_payment_dues(text, text, integer, integer),
  public.list_payments_received(date, date, integer, integer),
  public.payments_overview()
from public, anon, authenticated;

grant execute on function
  public.create_project(text, text, date, date, uuid, text, text, text, text, numeric, numeric, numeric, jsonb, jsonb, boolean, jsonb),
  public.project_payment_status(uuid),
  public.list_payment_dues(text, text, integer, integer),
  public.list_payments_received(date, date, integer, integer),
  public.payments_overview()
to authenticated;
