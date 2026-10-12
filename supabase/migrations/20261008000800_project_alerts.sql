-- ---------------------------------------------------------------------------
-- Telegram alerts for the projects module (Star Gardens). All go through the existing
-- queue (private.enqueue_notification → telegram_notifications → reminder worker), so the
-- per-user switches in Settings, role checks and retries apply.
--
--   lead_handed_off        admins                    a BDM hands over an interested lead
--   project_assigned       the new team member       added to a project
--   phase_assigned         the new phase owner       a phase is given to them
--   phase_due_soon         owner + architect mgrs    the day before the deadline (9 AM IST)
--   phase_overdue          owner + architect mgrs + admins, once a day while late (10 AM IST)
--   phase_submitted        architect mgrs (else admins) a phase goes to review
--   phase_changes          the owner                 changes requested on their phase
--   project_at_risk        admins + architect mgrs   end date passed, or a phase runs past it
--   site_visit_reminder    the visitor               about an hour before a visit
--   payment_due            admin + account           a payment part falls due
--   payment_overdue        admin + account           weekly while a part is overdue
--   payment_received       admin + account           Accounts records a payment
--   boq_status             the team                  a BOQ is sent or approved
--   snag_assigned          the snag owner            a snag is given to them
--   project_completed      admins + the team         a project is marked completed
-- Dedupe keys make each alert once per event (or once per day/week for repeats).
-- ---------------------------------------------------------------------------

alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check check (kind in (
  'recurring_expense', 'lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
  'expense_added', 'capital_added', 'library_file_added', 'digest_sales', 'digest_admin', 'digest_finance', 'test',
  'ads_client_new', 'ad_account_problem',
  'lead_handed_off', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted',
  'phase_changes', 'project_at_risk', 'site_visit_reminder', 'payment_due', 'payment_overdue', 'payment_received',
  'boq_status', 'snag_assigned', 'project_completed'));

create or replace function private.notification_kinds_for(p_role public.app_role)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_role
    when 'admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'ads_client_new', 'ad_account_problem', 'test',
      'lead_handed_off', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted', 'phase_changes',
      'project_at_risk', 'site_visit_reminder', 'payment_due', 'payment_overdue', 'payment_received', 'boq_status', 'snag_assigned', 'project_completed']
    when 'super_admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'ads_client_new', 'ad_account_problem', 'test',
      'lead_handed_off', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted', 'phase_changes',
      'project_at_risk', 'site_visit_reminder', 'payment_due', 'payment_overdue', 'payment_received', 'boq_status', 'snag_assigned', 'project_completed']
    when 'sales' then array['lead_assigned', 'follow_up_changed', 'overdue_nag', 'library_file_added', 'digest_sales', 'test', 'site_visit_reminder']
    when 'account' then array['expense_added', 'capital_added', 'recurring_expense', 'digest_finance', 'test',
      'payment_due', 'payment_overdue', 'payment_received']
    when 'ads_manager' then array['ads_client_new', 'ad_account_problem', 'test']
    when 'architect_manager' then array['test', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted',
      'project_at_risk', 'site_visit_reminder', 'boq_status', 'snag_assigned', 'project_completed']
    when 'landscape_designer' then array['test', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_changes',
      'site_visit_reminder', 'boq_status', 'snag_assigned', 'project_completed']
    when 'execution' then array['test', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue',
      'boq_status', 'snag_assigned', 'project_completed']
    else array[]::text[] end
$$;

-- ---------------------------------------------------------------------------
-- Recipient helpers
-- ---------------------------------------------------------------------------
create function private.project_payload(p_project_id uuid, p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('project_id', p.id, 'project', p.name, 'code', p.code, 'client', p.client_name) || coalesce(p_extra, '{}'::jsonb)
  from public.projects p where p.id = p_project_id
$$;

-- Team members of a project in the given roles (and the company's admins when asked).
create function private.enqueue_for_project(
  p_project_id uuid, p_roles public.project_member_role[], p_admins boolean, p_kind text, p_payload jsonb, p_dedupe text, p_actor uuid default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer := 0;
  v_company uuid := (select p.company_id from public.projects p where p.id = p_project_id);
  r record;
begin
  for r in
    select distinct m.user_id from public.project_members m
    where m.project_id = p_project_id and m.removed_at is null and m.member_role = any(p_roles)
  loop
    if private.enqueue_notification(r.user_id, p_kind, p_payload, p_dedupe, p_actor) then
      v_count := v_count + 1;
    end if;
  end loop;
  if p_admins then
    v_count := v_count + private.enqueue_for_company(v_company, array['admin']::public.app_role[], p_kind, p_payload, p_dedupe, p_actor);
  end if;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Event triggers
-- ---------------------------------------------------------------------------
create function private.notify_lead_handed_off()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_for_company(new.company_id, array['admin']::public.app_role[], 'lead_handed_off', jsonb_build_object(
    'lead_id', new.id, 'lead_name', new.name, 'phone', new.phone, 'note', new.handoff_note,
    'actor', private.display_name(new.handoff_by)), 'lead_handed_off:' || new.id, new.handoff_by, new.id);
  return null;
end $$;

create trigger leads_notify_handoff after update on public.leads
  for each row when (old.handoff_at is null and new.handoff_at is not null) execute function private.notify_lead_handed_off();

create function private.notify_project_member()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.member_role <> 'client' then
    perform private.enqueue_notification(new.user_id, 'project_assigned', private.project_payload(new.project_id, jsonb_build_object(
      'role', new.member_role, 'actor', private.display_name(new.added_by))), 'project_assigned:' || new.id, new.added_by);
  end if;
  return null;
end $$;

create trigger project_members_notify after insert on public.project_members
  for each row execute function private.notify_project_member();

create function private.notify_phase_change()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
begin
  v_payload := private.project_payload(new.project_id, jsonb_build_object('phase_id', new.id, 'phase', new.name,
    'deadline', new.deadline, 'actor', private.display_name(v_uid)));
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) then
    perform private.enqueue_notification(new.owner_id, 'phase_assigned', v_payload,
      'phase_assigned:' || new.id || ':' || new.owner_id || ':' || new.version, v_uid);
  end if;
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'in_review' then
      if exists (select 1 from public.project_members m where m.project_id = new.project_id and m.member_role = 'architect_manager' and m.removed_at is null) then
        perform private.enqueue_for_project(new.project_id, array['architect_manager']::public.project_member_role[], false,
          'phase_submitted', v_payload || jsonb_build_object('late_days', greatest(coalesce(new.submitted_on, private.ist_today()) - new.deadline, 0)),
          'phase_submitted:' || new.id || ':' || new.version, v_uid);
      else
        perform private.enqueue_for_project(new.project_id, '{}'::public.project_member_role[], true, 'phase_submitted',
          v_payload || jsonb_build_object('late_days', greatest(coalesce(new.submitted_on, private.ist_today()) - new.deadline, 0)),
          'phase_submitted:' || new.id || ':' || new.version, v_uid);
      end if;
    elsif new.status = 'changes_requested' and new.owner_id is not null then
      perform private.enqueue_notification(new.owner_id, 'phase_changes', v_payload || jsonb_build_object('remark', new.remark),
        'phase_changes:' || new.id || ':' || new.version, v_uid);
    end if;
  end if;
  return null;
end $$;

create trigger project_phases_notify after insert or update on public.project_phases
  for each row execute function private.notify_phase_change();

create function private.notify_payment_received()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_for_company((select p.company_id from public.projects p where p.id = new.project_id),
    array['admin', 'account']::public.app_role[], 'payment_received', private.project_payload(new.project_id, jsonb_build_object(
      'amount', new.amount, 'mode', new.mode, 'paid_on', new.paid_on, 'reference', new.reference,
      'milestone', (select m.label from public.project_payment_milestones m where m.id = new.milestone_id),
      'actor', private.display_name(new.created_by))), 'payment_received:' || new.id, new.created_by);
  return null;
end $$;

create trigger project_payments_notify after insert on public.project_payments
  for each row execute function private.notify_payment_received();

create function private.notify_boq_status()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('sent', 'client_approved') then
    perform private.enqueue_for_project(new.project_id, array['architect_manager', 'landscape_designer', 'execution']::public.project_member_role[], false,
      'boq_status', private.project_payload(new.project_id, jsonb_build_object('label', new.label, 'status', new.status,
        'actor', private.display_name((select auth.uid())))), 'boq_status:' || new.id || ':' || new.status, (select auth.uid()));
  end if;
  return null;
end $$;

create trigger boq_revisions_notify after update on public.project_boq_revisions
  for each row when (new.status is distinct from old.status) execute function private.notify_boq_status();

create function private.notify_snag()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) then
    perform private.enqueue_notification(new.owner_id, 'snag_assigned', private.project_payload(new.project_id, jsonb_build_object(
      'snag', new.title, 'actor', private.display_name((select auth.uid())))), 'snag_assigned:' || new.id || ':' || new.owner_id, (select auth.uid()));
  end if;
  return null;
end $$;

create trigger project_snags_notify after insert or update on public.project_snags
  for each row execute function private.notify_snag();

create function private.notify_project_completed()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.enqueue_for_project(new.id, array['architect_manager', 'landscape_designer', 'execution']::public.project_member_role[], true,
    'project_completed', private.project_payload(new.id, jsonb_build_object('end_date', new.end_date, 'completed_on', new.completed_on,
      'actor', private.display_name((select auth.uid())))), 'project_completed:' || new.id, (select auth.uid()));
  return null;
end $$;

create trigger projects_notify_completed after update on public.projects
  for each row when (new.status = 'completed' and old.status <> 'completed') execute function private.notify_project_completed();

-- ---------------------------------------------------------------------------
-- Timed alerts (cron, every 15 minutes; each alert once per window via its dedupe key)
-- ---------------------------------------------------------------------------
create function private.enqueue_project_alerts(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_today date := v_local::date;
  v_hour integer := extract(hour from v_local);
  v_week text := to_char(v_local, 'IYYY-IW');
  v_count integer := 0;
  r record;
  v_payload jsonb;
begin
  -- Visits about an hour away (any time of day).
  for r in
    select v.* from public.site_visits v
    join public.companies c on c.id = v.company_id and 'projects' = any(c.features) and c.archived_at is null
    where v.status = 'scheduled' and v.scheduled_at > p_now + interval '30 minutes' and v.scheduled_at <= p_now + interval '75 minutes'
  loop
    if private.enqueue_notification(r.assigned_to, 'site_visit_reminder', jsonb_strip_nulls(jsonb_build_object(
        'visit_id', r.id, 'purpose', r.purpose, 'at', r.scheduled_at, 'project_id', r.project_id,
        'project', (select p.name from public.projects p where p.id = r.project_id),
        'site_address', (select p.site_address from public.projects p where p.id = r.project_id),
        'lead_id', case when r.project_id is null then r.lead_id end,
        'lead', (select l.name from public.leads l where l.id = r.lead_id),
        'phone', coalesce((select p.client_phone from public.projects p where p.id = r.project_id), (select l.phone from public.leads l where l.id = r.lead_id)))),
      'site_visit_reminder:' || r.id || ':' || extract(epoch from r.scheduled_at)::bigint) then
      v_count := v_count + 1;
    end if;
  end loop;

  -- Mornings: phases due tomorrow and payment parts that fell due.
  if v_hour between 9 and 11 then
    for r in
      select ph.*, p.company_id from public.project_phases ph
      join public.projects p on p.id = ph.project_id and p.archived_at is null and p.status = 'active'
      join public.companies c on c.id = p.company_id and 'projects' = any(c.features)
      where ph.archived_at is null and ph.status not in ('done', 'skipped', 'in_review') and ph.deadline = v_today + 1
    loop
      v_payload := private.project_payload(r.project_id, jsonb_build_object('phase_id', r.id, 'phase', r.name, 'deadline', r.deadline,
        'owner', private.display_name(r.owner_id)));
      if r.owner_id is not null and private.enqueue_notification(r.owner_id, 'phase_due_soon', v_payload, 'phase_due_soon:' || r.id || ':' || r.deadline) then
        v_count := v_count + 1;
      end if;
      v_count := v_count + private.enqueue_for_project(r.project_id, array['architect_manager']::public.project_member_role[], false,
        'phase_due_soon', v_payload, 'phase_due_soon:' || r.id || ':' || r.deadline);
    end loop;

    for r in
      select m.*, p.company_id, private.milestone_json(m, true) as j from public.project_payment_milestones m
      join public.projects p on p.id = m.project_id and p.archived_at is null and p.status <> 'cancelled'
      join public.companies c on c.id = p.company_id and 'projects' = any(c.features)
      where m.archived_at is null
    loop
      continue when r.j ->> 'status' not in ('due', 'partly_paid') or (r.j ->> 'due_on') is null;
      v_count := v_count + private.enqueue_for_company(r.company_id, array['admin', 'account']::public.app_role[], 'payment_due',
        private.project_payload(r.project_id, jsonb_build_object('milestone', r.label, 'amount', r.amount, 'balance', r.j -> 'balance',
          'due_on', r.j ->> 'due_on')), 'payment_due:' || r.id || ':' || (r.j ->> 'due_on'));
    end loop;
  end if;

  -- Late mornings: late phases (daily), projects past their end, payments overdue (weekly, Mondays).
  if v_hour between 10 and 12 then
    for r in
      select ph.*, p.company_id from public.project_phases ph
      join public.projects p on p.id = ph.project_id and p.archived_at is null and p.status = 'active'
      join public.companies c on c.id = p.company_id and 'projects' = any(c.features)
      where ph.archived_at is null and ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today
    loop
      v_payload := private.project_payload(r.project_id, jsonb_build_object('phase_id', r.id, 'phase', r.name, 'deadline', r.deadline,
        'late_days', v_today - r.deadline, 'owner', private.display_name(r.owner_id)));
      if r.owner_id is not null and private.enqueue_notification(r.owner_id, 'phase_overdue', v_payload, 'phase_overdue:' || r.id || ':' || v_today) then
        v_count := v_count + 1;
      end if;
      v_count := v_count + private.enqueue_for_project(r.project_id, array['architect_manager']::public.project_member_role[], true,
        'phase_overdue', v_payload, 'phase_overdue:' || r.id || ':' || v_today);
    end loop;

    for r in
      select p.*, (select max(ph.deadline) from public.project_phases ph where ph.project_id = p.id and ph.archived_at is null
          and ph.status not in ('done', 'skipped')) as last_deadline
      from public.projects p
      join public.companies c on c.id = p.company_id and 'projects' = any(c.features)
      where p.archived_at is null and p.status = 'active'
    loop
      if r.end_date < v_today then
        v_count := v_count + private.enqueue_for_project(r.id, array['architect_manager']::public.project_member_role[], true, 'project_at_risk',
          private.project_payload(r.id, jsonb_build_object('reason', 'past_end', 'end_date', r.end_date, 'late_days', v_today - r.end_date)),
          'project_at_risk:past_end:' || r.id || ':' || v_week);
      elsif r.last_deadline > r.end_date then
        v_count := v_count + private.enqueue_for_project(r.id, array['architect_manager']::public.project_member_role[], true, 'project_at_risk',
          private.project_payload(r.id, jsonb_build_object('reason', 'phase_after_end', 'end_date', r.end_date, 'last_deadline', r.last_deadline)),
          'project_at_risk:phase_after_end:' || r.id || ':' || r.last_deadline);
      end if;
    end loop;

    if extract(isodow from v_local) = 1 then
      for r in
        select m.*, p.company_id, private.milestone_json(m, true) as j from public.project_payment_milestones m
        join public.projects p on p.id = m.project_id and p.archived_at is null and p.status <> 'cancelled'
        join public.companies c on c.id = p.company_id and 'projects' = any(c.features)
        where m.archived_at is null
      loop
        continue when r.j ->> 'status' <> 'overdue';
        v_count := v_count + private.enqueue_for_company(r.company_id, array['admin', 'account']::public.app_role[], 'payment_overdue',
          private.project_payload(r.project_id, jsonb_build_object('milestone', r.label, 'balance', r.j -> 'balance',
            'due_on', r.j ->> 'due_on', 'days_overdue', r.j -> 'days_overdue')), 'payment_overdue:' || r.id || ':' || v_week);
      end loop;
    end if;
  end if;
  return v_count;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-project-alerts', '*/15 * * * *', 'select private.enqueue_project_alerts()');
  end if;
end $$;

-- Send-time recheck: project alerts only reach people who still have the project.
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
      nullif(n.payload ->> 'project_id', '')::uuid as project_id,
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
    elsif r.project_id is not null and not (
      -- Project alerts: the recipient must still be on the project (admins: in its company; money alerts: admin/account).
      exists (select 1 from public.projects pr where pr.id = r.project_id and pr.archived_at is null and (
        r.role = 'super_admin'
        or ((r.role = 'admin' or 'admin' = any(r.extra_roles)) and pr.company_id = r.company_id)
        or (r.kind in ('payment_due', 'payment_overdue', 'payment_received')
            and (r.role = 'account' or 'account' = any(r.extra_roles)) and pr.company_id = r.company_id)
        or (r.kind not in ('payment_due', 'payment_overdue', 'payment_received') and exists (
            select 1 from public.project_members m where m.project_id = pr.id and m.user_id = r.recipient_id
              and m.removed_at is null and m.member_role <> 'client'))))) then
      v_skip := 'no_project_access';
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
-- The reminder worker's "is there work?" check also wakes for queued project alerts (same table).

revoke all on function
  private.project_payload(uuid, jsonb),
  private.enqueue_for_project(uuid, public.project_member_role[], boolean, text, jsonb, text, uuid),
  private.notify_lead_handed_off(),
  private.notify_project_member(),
  private.notify_phase_change(),
  private.notify_payment_received(),
  private.notify_boq_status(),
  private.notify_snag(),
  private.notify_project_completed(),
  private.enqueue_project_alerts(timestamptz)
from public, anon, authenticated;
