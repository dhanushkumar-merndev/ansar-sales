-- Dashboards: optional explicit IST day range [p_from, p_to] (inclusive), so the
-- dashboard can use the same range picker as Reports. Without it, p_days still
-- means "the last N days ending today".

drop function if exists public.dashboard_admin(integer);
drop function if exists public.dashboard_sales(integer);


create function public.dashboard_admin(p_days integer default 30, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_from is not null or p_to is not null then
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 1100 then
      raise exception 'invalid_range' using errcode = '22023';
    end if;
    v_from := p_from;
    v_to := p_to;
  else
    p_days := least(greatest(coalesce(p_days, 30), 7), 365);
    v_from := v_today - (p_days - 1);
    v_to := v_today;
  end if;

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_to - v_from + 1),
    'cards', (
      select jsonb_build_object(
        'active_leads', count(*) filter (where l.status not in ('won', 'lost')),
        'won_leads', count(*) filter (where l.status = 'won'),
        'lost_leads', count(*) filter (where l.status = 'lost'),
        'today_pending', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.state = 'pending' and (f.due_at at time zone 'Asia/Kolkata')::date = v_today),
        'overdue', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.state = 'pending' and f.due_at < now()))
      from public.leads l where l.archived_at is null),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object('date', d.day::date, 'count', coalesce(c.cnt, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as d(day)
      left join (
        select (l.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as cnt
        from public.leads l
        where l.archived_at is null and l.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
          and l.created_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata')
        group by 1
      ) c on c.day = d.day::date),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.status), '[]'::jsonb)
      from (select l.status, count(*) as cnt from public.leads l where l.archived_at is null group by l.status) s),
    'salespeople', (
      select coalesce(jsonb_agg(x order by (x ->> 'active')::int desc, x ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.display_name,
          'active', count(l.id) filter (where l.status not in ('won', 'lost')),
          'won', count(l.id) filter (where l.status = 'won'),
          'lost', count(l.id) filter (where l.status = 'lost')) as x
        from public.profiles p
        join public.leads l on l.owner_id = p.id and l.archived_at is null
        group by p.id, p.display_name
        order by count(l.id) filter (where l.status not in ('won', 'lost')) desc, p.display_name
        limit 15
      ) t),
    'niches', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'count', t.cnt) order by t.cnt desc, t.name), '[]'::jsonb)
      from (
        select n.name, count(*) as cnt from public.leads l join public.niches n on n.id = l.niche_id
        where l.archived_at is null group by n.name order by count(*) desc, n.name limit 8
      ) t)
  ) into v_result;
  return v_result;
end $$;

create function public.dashboard_sales(p_days integer default 30, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_today date := private.ist_today();
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if p_from is not null or p_to is not null then
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 1100 then
      raise exception 'invalid_range' using errcode = '22023';
    end if;
    v_from := p_from;
    v_to := p_to;
  else
    p_days := least(greatest(coalesce(p_days, 30), 7), 365);
    v_from := v_today - (p_days - 1);
    v_to := v_today;
  end if;

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_to - v_from + 1),
    'cards', (
      select jsonb_build_object(
        'active_leads', count(*) filter (where l.status not in ('won', 'lost')),
        'won_leads', count(*) filter (where l.status = 'won'),
        'lost_leads', count(*) filter (where l.status = 'lost'),
        'today_pending', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.assignee_id = v_uid and f.state = 'pending' and (f.due_at at time zone 'Asia/Kolkata')::date = v_today),
        'overdue', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.assignee_id = v_uid and f.state = 'pending' and f.due_at < now()))
      from public.leads l where l.owner_id = v_uid and l.archived_at is null),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.status), '[]'::jsonb)
      from (select l.status, count(*) as cnt from public.leads l
            where l.owner_id = v_uid and l.archived_at is null group by l.status) s),
    'activity', (
      select coalesce(jsonb_agg(jsonb_build_object('date', d.day::date, 'count', coalesce(c.cnt, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as d(day)
      left join (
        select (a.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as cnt
        from public.lead_activities a
        where a.actor_id = v_uid and a.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
          and a.created_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata')
        group by 1
      ) c on c.day = d.day::date)
  ) into v_result;
  return v_result;
end $$;

revoke all on function
  public.dashboard_admin(integer, date, date),
  public.dashboard_sales(integer, date, date)
from public, anon;

grant execute on function
  public.dashboard_admin(integer, date, date),
  public.dashboard_sales(integer, date, date)
to authenticated;
