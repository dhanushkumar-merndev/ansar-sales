-- ---------------------------------------------------------------------------
-- Admin dashboard for the projects module: headline numbers, phase timeliness,
-- projects by current stage, and the team board (each person → what they're on now).
-- Money numbers only when the caller may see money.
-- ---------------------------------------------------------------------------
create function public.projects_dashboard()
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
          'leads', case when p.role = 'sales' or 'sales' = any(p.extra_roles) then coalesce((select jsonb_agg(jsonb_build_object('stage', s.name, 'count', s.n) order by s.position)
            from (select st.name, st.position, count(*) as n from public.leads l join public.pipeline_stages st on st.id = l.stage_id
              where l.owner_id = p.id and l.archived_at is null and l.status = 'open' group by st.name, st.position) s), '[]'::jsonb) end
        ) as t
        from public.profiles p
        where p.company_id = v_company and p.is_active and p.role not in ('client')
          and (p.role in ('sales', 'architect_manager', 'landscape_designer', 'execution')
               or p.extra_roles && array['sales', 'architect_manager', 'landscape_designer', 'execution']::public.app_role[])
      ) x), '[]'::jsonb)
    )
  );
end $$;

revoke all on function public.projects_dashboard() from public, anon, authenticated;
grant execute on function public.projects_dashboard() to authenticated;
