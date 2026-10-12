-- ---------------------------------------------------------------------------
-- BOQ revisions, execution site logs, and the handover snag list.
--
-- BOQ (bill of quantities): revisions R0…R4, each a sheet of items by section
-- (hardscape / softscape / …) with qty × rate = amount (exact numeric). Designers and the
-- architect manager edit drafts; the manager marks a revision sent / client approved
-- (approving one supersedes the previous approved revision). Execution records the
-- executed quantity only.
-- Site logs: what was done each day on site (rich notes), workers, issues.
-- Snags: items to fix before handover, with owner and status.
-- Everyone working on the project (admin + team) can read; account is not part of this.
-- ---------------------------------------------------------------------------

-- Team (not clients, not account-only): admin or an active member.
create function private.can_work_on_project(p_project_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.company_id = private.current_company_id() and private.company_has('projects')
      and (private.is_admin() or exists (select 1 from public.project_members m
        where m.project_id = p.id and m.user_id = (select auth.uid()) and m.removed_at is null and m.member_role <> 'client')))
$$;

create function private.project_member_role_of(p_project_id uuid)
returns public.project_member_role[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(m.member_role), '{}') from public.project_members m
  where m.project_id = p_project_id and m.user_id = (select auth.uid()) and m.removed_at is null
$$;

-- ---------------------------------------------------------------------------
-- BOQ
-- ---------------------------------------------------------------------------
create table public.project_boq_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 20),
  title text check (title is null or char_length(title) <= 120),
  status text not null default 'draft' check (status in ('draft', 'sent', 'client_approved', 'superseded')),
  notes text check (notes is null or char_length(notes) <= 2000),
  sent_at timestamptz,
  approved_at timestamptz,
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index project_boq_revisions_label_key on public.project_boq_revisions (project_id, lower(label)) where archived_at is null;
create index project_boq_revisions_project_idx on public.project_boq_revisions (project_id, created_at) where archived_at is null;

create table public.project_boq_items (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references public.project_boq_revisions (id) on delete cascade,
  position integer not null default 0,
  section text not null default 'Hardscape' check (char_length(btrim(section)) between 1 and 40),
  item text not null check (char_length(btrim(item)) between 1 and 200),
  description text check (description is null or char_length(description) <= 500),
  unit text not null default 'nos' check (char_length(btrim(unit)) between 1 and 20),
  qty numeric(12, 2) not null default 0 check (qty >= 0),
  rate numeric(12, 2) not null default 0 check (rate >= 0),
  amount numeric(14, 2) generated always as (round(qty * rate, 2)) stored,
  executed_qty numeric(12, 2) not null default 0 check (executed_qty >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index project_boq_items_revision_idx on public.project_boq_items (revision_id, position, id) where archived_at is null;

-- ---------------------------------------------------------------------------
-- Site logs and snags
-- ---------------------------------------------------------------------------
create table public.project_site_logs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  log_date date not null,
  work_done jsonb check (work_done is null or (jsonb_typeof(work_done) = 'object' and pg_column_size(work_done) <= 200000)),
  workers integer check (workers is null or workers between 0 and 1000),
  issues text check (issues is null or char_length(issues) <= 2000),
  version integer not null default 1,
  created_by uuid not null default auth.uid() references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index project_site_logs_day_key on public.project_site_logs (project_id, log_date, created_by) where archived_at is null;
create index project_site_logs_project_idx on public.project_site_logs (project_id, log_date desc) where archived_at is null;

create table public.project_snags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  details text check (details is null or char_length(details) <= 2000),
  status text not null default 'open' check (status in ('open', 'fixed', 'verified')),
  owner_id uuid references public.profiles (id),
  due_date date,
  fixed_at timestamptz,
  fixed_by uuid references public.profiles (id),
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create index project_snags_project_idx on public.project_snags (project_id, status, created_at) where archived_at is null;
create index project_snags_owner_idx on public.project_snags (owner_id, status) where archived_at is null;

alter table public.project_activities drop constraint project_activities_type_check;
alter table public.project_activities add constraint project_activities_type_check check (type in (
  'project_created', 'project_updated', 'status_changed', 'member_added', 'member_removed', 'note',
  'phase_added', 'phase_updated', 'phase_rescheduled', 'phase_status_changed', 'phase_owner_changed', 'phase_removed',
  'payment_recorded', 'payment_updated', 'payment_removed', 'schedule_changed',
  'visit_scheduled', 'visit_checked_in', 'visit_completed', 'visit_cancelled',
  'boq_created', 'boq_status_changed', 'site_log_added', 'snag_opened', 'snag_fixed', 'snag_verified', 'snag_reopened'));

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create function private.boq_revisions_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.label := upper(btrim(new.label));
  new.title := private.clean_label(new.title);
  if tg_op = 'INSERT' then
    new.version := 1;
    new.status := 'draft';
    new.created_by := coalesce(v_uid, new.created_by);
    new.created_at := now();
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    if new.status is distinct from old.status then
      if v_uid is not null and not private.can_manage_project(old.project_id) and current_setting('crm.boq_supersede', true) is distinct from 'on' then
        perform private.raise_forbidden();
      end if;
      if new.status = 'sent' then new.sent_at := coalesce(old.sent_at, now()); end if;
      if new.status = 'client_approved' then
        new.approved_at := now();
        new.sent_at := coalesce(new.sent_at, now());
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger boq_revisions_before_write before insert or update on public.project_boq_revisions
  for each row execute function private.boq_revisions_before_write();

create function private.boq_revisions_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_project(new.project_id, 'boq_created', jsonb_build_object('label', new.label, 'title', new.title));
  elsif new.status is distinct from old.status then
    perform private.log_project(new.project_id, 'boq_status_changed', jsonb_build_object('label', new.label, 'from', old.status, 'to', new.status));
    -- One approved revision at a time: approving supersedes the earlier approved one.
    if new.status = 'client_approved' then
      perform set_config('crm.boq_supersede', 'on', true);
      update public.project_boq_revisions set status = 'superseded'
      where project_id = new.project_id and id <> new.id and status = 'client_approved' and archived_at is null;
      perform set_config('crm.boq_supersede', 'off', true);
    end if;
  end if;
  return null;
end $$;

create trigger boq_revisions_after_write after insert or update on public.project_boq_revisions
  for each row execute function private.boq_revisions_after_write();

create function private.boq_items_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_rev public.project_boq_revisions%rowtype;
  v_roles public.project_member_role[];
  v_editor boolean;
begin
  select * into v_rev from public.project_boq_revisions where id = coalesce(new.revision_id, old.revision_id);
  new.section := coalesce(private.clean_label(new.section), 'Hardscape');
  new.item := btrim(new.item);
  new.unit := coalesce(private.clean_label(new.unit), 'nos');
  new.description := private.clean_label(new.description);
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.revision_id := old.revision_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  if (select auth.uid()) is null then
    return new;
  end if;
  v_roles := private.project_member_role_of(v_rev.project_id);
  v_editor := private.can_manage_project(v_rev.project_id) or 'landscape_designer' = any(v_roles);
  -- Drafts are edited by the manager and designers; a sent/approved sheet only takes executed quantities.
  if tg_op = 'INSERT' or new.item is distinct from old.item or new.qty is distinct from old.qty or new.rate is distinct from old.rate
     or new.section is distinct from old.section or new.unit is distinct from old.unit or new.description is distinct from old.description
     or new.position is distinct from old.position or new.archived_at is distinct from old.archived_at then
    if not v_editor then
      perform private.raise_forbidden();
    end if;
    if v_rev.status <> 'draft' then
      raise exception 'boq_locked' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.executed_qty is distinct from old.executed_qty
     and not (private.can_manage_project(v_rev.project_id) or 'execution' = any(v_roles)) then
    perform private.raise_forbidden();
  end if;
  return new;
end $$;

create trigger boq_items_before_write before insert or update on public.project_boq_items
  for each row execute function private.boq_items_before_write();

create function private.site_logs_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.issues := nullif(btrim(coalesce(new.issues, '')), '');
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
    if new.log_date > private.ist_today() then
      raise exception 'future_log' using errcode = '22023';
    end if;
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.log_date := old.log_date;
    new.version := old.version + 1;
    if (select auth.uid()) is not null and old.created_by <> (select auth.uid()) and not private.can_manage_project(old.project_id) then
      perform private.raise_forbidden();
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger site_logs_before_write before insert or update on public.project_site_logs
  for each row execute function private.site_logs_before_write();

create function private.site_logs_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.log_project(new.project_id, 'site_log_added', jsonb_build_object('log_id', new.id, 'date', new.log_date,
    'workers', new.workers, 'issues', left(new.issues, 200)));
  return null;
end $$;

create trigger site_logs_after_insert after insert on public.project_site_logs
  for each row execute function private.site_logs_after_write();

create function private.snags_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.title := btrim(new.title);
  new.details := nullif(btrim(coalesce(new.details, '')), '');
  if tg_op = 'INSERT' then
    new.version := 1;
    new.status := 'open';
    new.created_by := coalesce((select auth.uid()), new.created_by);
    new.created_at := now();
  else
    new.id := old.id;
    new.project_id := old.project_id;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version := old.version + 1;
    if new.status is distinct from old.status then
      if new.status = 'fixed' then
        new.fixed_at := now();
        new.fixed_by := (select auth.uid());
      elsif new.status = 'open' then
        new.fixed_at := null;
        new.fixed_by := null;
      elsif new.status = 'verified' and (select auth.uid()) is not null and not private.can_manage_project(old.project_id) then
        perform private.raise_forbidden();
      end if;
    end if;
  end if;
  new.updated_at := now();
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) and not exists (
    select 1 from public.project_members m where m.project_id = new.project_id and m.user_id = new.owner_id and m.removed_at is null and m.member_role <> 'client'
  ) then
    raise exception 'owner_not_on_project' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger snags_before_write before insert or update on public.project_snags
  for each row execute function private.snags_before_write();

create function private.snags_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.log_project(new.project_id, 'snag_opened', jsonb_build_object('snag_id', new.id, 'title', new.title, 'owner', private.display_name(new.owner_id)));
  elsif new.status is distinct from old.status then
    perform private.log_project(new.project_id, case new.status when 'fixed' then 'snag_fixed' when 'verified' then 'snag_verified' else 'snag_reopened' end,
      jsonb_build_object('snag_id', new.id, 'title', new.title));
  end if;
  return null;
end $$;

create trigger snags_after_write after insert or update on public.project_snags
  for each row execute function private.snags_after_write();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.project_boq_revisions enable row level security;
alter table public.project_boq_items enable row level security;
alter table public.project_site_logs enable row level security;
alter table public.project_snags enable row level security;

create policy boq_revisions_select on public.project_boq_revisions for select to authenticated
  using ((select private.can_work_on_project(project_id)));
create policy boq_revisions_insert on public.project_boq_revisions for insert to authenticated
  with check ((select private.can_manage_project(project_id)) or (select 'landscape_designer' = any(private.project_member_role_of(project_id))));
create policy boq_revisions_update on public.project_boq_revisions for update to authenticated
  using ((select private.can_manage_project(project_id)) or (select 'landscape_designer' = any(private.project_member_role_of(project_id))));

create policy boq_items_select on public.project_boq_items for select to authenticated
  using (exists (select 1 from public.project_boq_revisions r where r.id = revision_id));
create policy boq_items_insert on public.project_boq_items for insert to authenticated
  with check (exists (select 1 from public.project_boq_revisions r where r.id = revision_id));
create policy boq_items_update on public.project_boq_items for update to authenticated
  using (exists (select 1 from public.project_boq_revisions r where r.id = revision_id));

create policy site_logs_select on public.project_site_logs for select to authenticated
  using ((select private.can_work_on_project(project_id)));
create policy site_logs_insert on public.project_site_logs for insert to authenticated
  with check ((select private.can_work_on_project(project_id)));
create policy site_logs_update on public.project_site_logs for update to authenticated
  using ((select private.can_work_on_project(project_id)));

create policy snags_select on public.project_snags for select to authenticated
  using ((select private.can_work_on_project(project_id)));
create policy snags_insert on public.project_snags for insert to authenticated
  with check ((select private.can_work_on_project(project_id)));
create policy snags_update on public.project_snags for update to authenticated
  using ((select private.can_work_on_project(project_id)));

revoke all on public.project_boq_revisions, public.project_boq_items, public.project_site_logs, public.project_snags from anon, authenticated;
grant select on public.project_boq_revisions, public.project_boq_items, public.project_site_logs, public.project_snags to authenticated;
grant insert (project_id, label, title, notes) on public.project_boq_revisions to authenticated;
grant update (label, title, notes, status, archived_at) on public.project_boq_revisions to authenticated;
grant insert (revision_id, position, section, item, description, unit, qty, rate) on public.project_boq_items to authenticated;
grant update (position, section, item, description, unit, qty, rate, executed_qty, archived_at) on public.project_boq_items to authenticated;
grant insert (project_id, log_date, work_done, workers, issues) on public.project_site_logs to authenticated;
grant update (work_done, workers, issues, archived_at) on public.project_site_logs to authenticated;
grant insert (project_id, title, details, owner_id, due_date) on public.project_snags to authenticated;
grant update (title, details, status, owner_id, due_date, archived_at) on public.project_snags to authenticated;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------
-- A new draft revision copied from an earlier one (e.g. R3 from the approved R2).
create function public.copy_boq_revision(p_revision_id uuid, p_label text)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_src public.project_boq_revisions%rowtype;
  v_new uuid;
begin
  select * into v_src from public.project_boq_revisions where id = p_revision_id and archived_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.project_boq_revisions (project_id, label, title, notes)
  values (v_src.project_id, p_label, v_src.title, null)
  returning id into v_new;
  insert into public.project_boq_items (revision_id, position, section, item, description, unit, qty, rate)
  select v_new, i.position, i.section, i.item, i.description, i.unit, i.qty, i.rate
  from public.project_boq_items i where i.revision_id = p_revision_id and i.archived_at is null;
  return v_new;
end $$;

-- Every revision of a project with its items and section totals.
create function public.project_boq(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_work_on_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'label', r.label, 'title', r.title, 'status', r.status, 'notes', r.notes, 'sent_at', r.sent_at,
      'approved_at', r.approved_at, 'version', r.version, 'created_at', r.created_at,
      'created_by', private.display_name(r.created_by),
      'total', (select coalesce(sum(i.amount), 0) from public.project_boq_items i where i.revision_id = r.id and i.archived_at is null),
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'position', i.position, 'section', i.section, 'item', i.item,
          'description', i.description, 'unit', i.unit, 'qty', i.qty, 'rate', i.rate, 'amount', i.amount, 'executed_qty', i.executed_qty)
        order by i.section, i.position, i.id)
        from public.project_boq_items i where i.revision_id = r.id and i.archived_at is null), '[]'::jsonb)
    ) order by r.created_at, r.id), '[]'::jsonb)
    from public.project_boq_revisions r
    where r.project_id = p_project_id and r.archived_at is null
  );
end $$;

-- The signed-in person's work across projects: phases they own, their visits, open snags,
-- and the sites missing today's log (execution).
create function public.my_work()
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_today date := private.ist_today();
begin
  if not private.company_has('projects') then
    perform private.raise_forbidden();
  end if;
  return jsonb_build_object(
    'today', v_today,
    'phases', coalesce((select jsonb_agg(private.phase_json(ph) || jsonb_build_object('project', jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'color', p.color))
        order by ph.deadline, ph.position, ph.id)
      from public.project_phases ph join public.projects p on p.id = ph.project_id and p.archived_at is null and p.status in ('active', 'on_hold')
      where ph.owner_id = v_uid and ph.archived_at is null and ph.status not in ('done', 'skipped')), '[]'::jsonb),
    'visits', coalesce((select jsonb_agg(private.site_visit_json(v) order by v.scheduled_at, v.id)
      from public.site_visits v where v.id in (select x.id from public.site_visits x
        where x.assigned_to = v_uid and x.status in ('scheduled', 'checked_in') order by x.scheduled_at limit 20)), '[]'::jsonb),
    'snags', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title, 'status', s.status, 'due_date', s.due_date,
        'project', jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code)) order by s.due_date nulls last, s.created_at)
      from public.project_snags s join public.projects p on p.id = s.project_id
      where s.owner_id = v_uid and s.status = 'open' and s.archived_at is null), '[]'::jsonb),
    'sites', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'code', p.code, 'site_address', p.site_address,
        'logged_today', exists (select 1 from public.project_site_logs l where l.project_id = p.id and l.log_date = v_today and l.created_by = v_uid and l.archived_at is null),
        'open_snags', (select count(*) from public.project_snags s where s.project_id = p.id and s.status = 'open' and s.archived_at is null))
        order by p.end_date, p.id)
      from public.projects p
      where p.archived_at is null and p.status = 'active' and exists (select 1 from public.project_members m
        where m.project_id = p.id and m.user_id = v_uid and m.member_role = 'execution' and m.removed_at is null)), '[]'::jsonb)
  );
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.project_boq_revisions, public.project_boq_items, public.project_site_logs, public.project_snags;
  end if;
end $$;

revoke all on function
  private.can_work_on_project(uuid),
  private.project_member_role_of(uuid),
  private.boq_revisions_before_write(),
  private.boq_revisions_after_write(),
  private.boq_items_before_write(),
  private.site_logs_before_write(),
  private.site_logs_after_write(),
  private.snags_before_write(),
  private.snags_after_write(),
  public.copy_boq_revision(uuid, text),
  public.project_boq(uuid),
  public.my_work()
from public, anon, authenticated;

grant execute on function private.can_work_on_project(uuid), private.project_member_role_of(uuid) to authenticated, service_role;
grant execute on function private.phase_json(public.project_phases) to authenticated;
grant execute on function public.copy_boq_revision(uuid, text), public.project_boq(uuid), public.my_work() to authenticated;
