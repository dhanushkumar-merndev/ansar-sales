-- ---------------------------------------------------------------------------
-- Team work: what each person on a manager's projects is doing — their open phases by status (in
-- progress, in review, changes requested, late) and what they did lately (phase moves, uploads, notes).
-- Admins see every project's team; an architect manager sees the people on the projects they manage.
-- Money stays out (payment-proof files and contract-value changes are not listed).
--
-- Also fixes the dashboard's team board for architect managers: it listed every staff member of the
-- company, with the BDMs' lead counts. Now: only people on their projects, and lead counts for admins only.
-- ---------------------------------------------------------------------------

create function public.team_work(p_days integer default 7)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_today date := private.ist_today();
  v_admin boolean := private.is_admin();
  v_since timestamptz;
begin
  if not private.company_has('projects') or not (v_admin or private.has_role('architect_manager')) then
    perform private.raise_forbidden();
  end if;
  if p_days is null or p_days not between 1 and 90 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  v_since := now() - make_interval(days => p_days);
  return (
    with prj as (
      select p.id, p.name, p.code from public.projects p
      where p.company_id = v_company and p.archived_at is null and p.status in ('active', 'on_hold')
        and (v_admin or private.can_manage_project(p.id))
    ),
    people as (
      select distinct pr.id, pr.display_name, pr.role, pr.extra_roles
      from public.project_members m join prj on prj.id = m.project_id join public.profiles pr on pr.id = m.user_id
      where m.removed_at is null and m.member_role <> 'client' and pr.is_active and pr.id <> (select auth.uid())
    ),
    ph as (
      select x.id, x.project_id, x.name, x.category, x.status, x.deadline, x.owner_id, x.updated_at,
        case when x.status not in ('done', 'skipped', 'in_review') and x.deadline < v_today then v_today - x.deadline else 0 end as late_days
      from public.project_phases x join prj on prj.id = x.project_id where x.archived_at is null
    ),
    acts as (
      select a.actor_id, a.created_at as at, 'activity' as source, a.type, a.meta, a.body, a.project_id, null::text as file
      from public.project_activities a join prj on prj.id = a.project_id
      where a.created_at >= v_since and a.actor_id in (select id from people)
        and not coalesce((a.meta ->> 'money')::boolean, false)
      union all
      select e.actor_id, e.created_at, 'file', e.type, '{}'::jsonb, e.comment, e.project_id, f.name
      from public.project_file_events e join prj on prj.id = e.project_id
      join public.project_files f on f.id = e.file_id join public.project_folders fo on fo.id = f.folder_id
      where e.created_at >= v_since and not e.from_client and not fo.restricted and e.actor_id in (select id from people)
        and e.type in ('uploaded', 'submitted', 'approved', 'changes_requested')
    )
    select jsonb_build_object('days', p_days, 'people', coalesce(jsonb_agg(t order by (t ->> 'late')::int desc, t ->> 'name'), '[]'::jsonb))
    from (
      select jsonb_build_object(
        'id', pe.id, 'name', pe.display_name, 'roles', to_jsonb(array[pe.role::text] || pe.extra_roles::text[]),
        'projects', coalesce((select jsonb_agg(jsonb_build_object('id', prj.id, 'name', prj.name, 'code', prj.code, 'role', m.member_role) order by prj.name)
          from public.project_members m join prj on prj.id = m.project_id
          where m.user_id = pe.id and m.removed_at is null and m.member_role <> 'client'), '[]'::jsonb),
        'in_progress', (select count(*) from ph where ph.owner_id = pe.id and ph.status = 'in_progress'),
        'in_review', (select count(*) from ph where ph.owner_id = pe.id and ph.status = 'in_review'),
        'changes', (select count(*) from ph where ph.owner_id = pe.id and ph.status = 'changes_requested'),
        'not_started', (select count(*) from ph where ph.owner_id = pe.id and ph.status = 'not_started'),
        'late', (select count(*) from ph where ph.owner_id = pe.id and ph.late_days > 0),
        -- In the period: phases they sent for review, and their phases a manager approved (done).
        'submitted', (select count(*) from acts where acts.actor_id = pe.id and acts.type = 'phase_status_changed' and acts.meta ->> 'to' = 'in_review'),
        'approved', (select count(*) from public.project_activities a join ph on ph.id = a.phase_id
          where ph.owner_id = pe.id and a.type = 'phase_status_changed' and a.meta ->> 'to' = 'done' and a.created_at >= v_since),
        'phases', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'project_id', ph.project_id, 'project', prj.name, 'name', ph.name,
            'stage', ph.category, 'status', ph.status, 'deadline', ph.deadline, 'late_days', ph.late_days, 'updated_at', ph.updated_at)
            order by (ph.late_days > 0) desc, case ph.status when 'changes_requested' then 0 when 'in_progress' then 1 when 'in_review' then 2 else 3 end, ph.deadline, ph.id)
          from (select * from ph where ph.owner_id = pe.id and ph.status not in ('done', 'skipped')
                order by (ph.late_days > 0) desc, ph.deadline limit 25) ph join prj on prj.id = ph.project_id), '[]'::jsonb),
        'recent', coalesce((select jsonb_agg(jsonb_build_object('at', r.at, 'source', r.source, 'type', r.type, 'meta', r.meta, 'body', left(r.body, 300),
            'project_id', r.project_id, 'project', prj.name, 'file', r.file) order by r.at desc)
          from (select * from acts where acts.actor_id = pe.id order by acts.at desc limit 8) r join prj on prj.id = r.project_id), '[]'::jsonb),
        'last_active', (select max(acts.at) from acts where acts.actor_id = pe.id)
      ) as t
      from people pe
    ) x
  );
end $$;

revoke all on function public.team_work(integer) from public, anon, authenticated;
grant execute on function public.team_work(integer) to authenticated;

create or replace function public.projects_dashboard()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_today date := private.ist_today();
  v_month date := date_trunc('month', private.ist_today())::date;
  v_money boolean := private.is_admin() or private.has_role('account');
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('architect_manager')) then
    perform private.raise_forbidden();
  end if;
  return (
    with prj as (
      select p.* from public.projects p
      where p.company_id = v_company and p.archived_at is null and p.status in ('active', 'on_hold')
        and (private.is_admin() or exists (select 1 from public.project_members m
          where m.project_id = p.id and m.user_id = (select auth.uid()) and m.removed_at is null))
    ),
    ph as (
      select x.*, (x.status not in ('done', 'skipped', 'in_review') and x.deadline < v_today) as late
      from public.project_phases x join prj on prj.id = x.project_id where x.archived_at is null
    ),
    cur as (
      select distinct on (ph.project_id) ph.project_id, ph.id, ph.name, ph.category, ph.status, ph.late, ph.owner_id
      from ph where ph.status not in ('done', 'skipped')
      order by ph.project_id, ph.planned_start, ph.position, ph.id
    )
    select jsonb_build_object(
      'cards', jsonb_build_object(
        'active_projects', (select count(*) from prj where prj.status = 'active'),
        'on_hold', (select count(*) from prj where prj.status = 'on_hold'),
        'late_phases', (select count(*) from ph where ph.late),
        'late_projects', (select count(distinct ph.project_id) from ph where ph.late),
        'due_this_week', (select count(*) from ph where ph.status not in ('done', 'skipped') and ph.deadline between v_today and v_today + 6),
        'handoffs_waiting', (select count(*) from public.leads l where l.company_id = v_company and l.handoff_at is not null
          and l.archived_at is null and not exists (select 1 from public.projects p where p.lead_id = l.id)),
        'collected_month', case when v_money then (select coalesce(sum(pp.amount), 0) from public.project_payments pp
          join public.projects p on p.id = pp.project_id where p.company_id = v_company and pp.archived_at is null and pp.paid_on >= v_month) end,
        'overdue_amount', case when v_money then (select coalesce(sum((private.milestone_json(m, true) ->> 'balance')::numeric) filter (
            where private.milestone_json(m, true) ->> 'status' = 'overdue'), 0)
          from public.project_payment_milestones m join prj on prj.id = m.project_id where m.archived_at is null) end),
      'timeliness', jsonb_build_object(
        'on_time', (select count(*) from ph where ph.status in ('done', 'in_review') and ph.submitted_on <= ph.deadline),
        'late_done', (select count(*) from ph where ph.status in ('done', 'in_review') and ph.submitted_on > ph.deadline),
        'late_open', (select count(*) from ph where ph.late),
        'open_on_track', (select count(*) from ph where ph.status not in ('done', 'skipped', 'in_review') and ph.deadline >= v_today)),
      'by_stage', coalesce((select jsonb_agg(jsonb_build_object('name', x.category, 'count', x.n) order by x.n desc, x.category) from (
        select cur.category, count(*) as n from cur group by cur.category) x), '[]'::jsonb),
      'team', coalesce((select jsonb_agg(t order by t ->> 'name') from (
        select jsonb_build_object(
          'id', p.id, 'name', p.display_name, 'roles', to_jsonb(array[p.role::text] || p.extra_roles::text[]),
          'projects', coalesce((select jsonb_agg(jsonb_build_object('id', prj.id, 'name', prj.name, 'role', m.member_role,
              'phase', cur.name, 'stage', cur.category, 'status', cur.status, 'late', coalesce(cur.late, false))
              order by prj.end_date, prj.id)
            from public.project_members m join prj on prj.id = m.project_id left join cur on cur.project_id = prj.id
            where m.user_id = p.id and m.removed_at is null and m.member_role <> 'client'), '[]'::jsonb),
          'open_phases', (select count(*) from ph where ph.owner_id = p.id and ph.status not in ('done', 'skipped')),
          'late_phases', (select count(*) from ph where ph.owner_id = p.id and ph.late),
          'leads', case when private.is_admin() and (p.role = 'sales' or 'sales' = any(p.extra_roles)) then coalesce((select jsonb_agg(jsonb_build_object('stage', s.name, 'count', s.n) order by s.position)
            from (select st.name, st.position, count(*) as n from public.leads l join public.pipeline_stages st on st.id = l.stage_id
              where l.owner_id = p.id and l.archived_at is null and l.status = 'open' group by st.name, st.position) s), '[]'::jsonb) end
        ) as t
        from public.profiles p
        where p.company_id = v_company and p.is_active and p.role not in ('client')
          and (p.role in ('sales', 'architect_manager', 'landscape_designer', 'execution')
               or p.extra_roles && array['sales', 'architect_manager', 'landscape_designer', 'execution']::public.app_role[])
          -- An architect manager sees the people on their projects, not the whole company.
          and (private.is_admin() or exists (select 1 from public.project_members m join prj on prj.id = m.project_id
            where m.user_id = p.id and m.removed_at is null and m.member_role <> 'client'))
      ) x), '[]'::jsonb)
    )
  );
end $$;
