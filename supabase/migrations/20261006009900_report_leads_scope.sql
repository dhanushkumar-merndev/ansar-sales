-- Reports: report_leads timed out (8 s statement limit) on ~4k activity rows, because RLS ran the
-- company/role checks once per row. It now runs as definer and applies exactly the same scope once:
-- the caller's current company; admins see all its leads, sales only the leads they own. Everything
-- else in the report (activities, follow-ups, closes) is reached through those leads.
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
        where p.role in ('sales', 'admin', 'super_admin')
          -- This company's people, plus anyone else (e.g. the super admin) who owns its leads.
          and ((p.company_id = v_company and p.is_active) or exists (select 1 from vl l where l.owner_id = p.id))
        order by p.display_name
        limit 30
      ) t) end
  ) into v_result;
  return v_result;
end $$;
