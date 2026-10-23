-- Faster lead / follow-up lists and dashboards. Same names, arguments and results; only how the rows are found changes.
--
-- list_leads (from 20261008004300): the page's ids are picked first (filters, pins and sort on leads only), and the
--   next follow-up, niche and owner are looked up for those <= 100 rows instead of for every visible lead. Sorting by
--   next follow-up still needs it for every row. Sorting by stage joins the stages instead of a subquery per row.
-- dashboard_admin / dashboard_sales (from 20261006009200): "due today" is a due-time range, so the pending index
--   applies, instead of converting every pending follow-up's time to a date.

create or replace function public.list_leads(
  p_search text default null,
  p_stage_ids uuid[] default null,
  p_niche_id uuid default null,
  p_owner_id uuid default null,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_overdue_only boolean default false,
  p_archived boolean default false,
  p_sort text default 'created_at',
  p_dir text default 'desc',
  p_limit integer default 20,
  p_offset integer default 0,
  p_starred_only boolean default false,
  p_temperature public.lead_temperature default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_digits text;
  v_order text;
  v_sort_join text := '';
  v_next_due text := $j$
      left join lateral (
        select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
  $j$;
  v_dir text := lower(coalesce(p_dir, 'desc'));
  v_total bigint;
  v_items jsonb;
  v_pinned bigint;
  v_where text := $w$
    where (case when $9 then l.archived_at is not null else l.archived_at is null end)
      and ($1::text is null or l.name ilike $1 or l.company_name ilike $1 or l.email ilike $1 or ($2::text is not null and l.phone_normalized like $2))
      and ($3::uuid[] is null or l.stage_id = any($3))
      and ($4::uuid is null or l.niche_id = $4)
      and ($5::uuid is null or l.owner_id = $5)
      and ($6::timestamptz is null or l.created_at >= $6)
      and ($7::timestamptz is null or l.created_at < $7)
      and (not $8 or exists (
        select 1 from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending' and f.due_at < now()))
      and (not $12 or exists (
        select 1 from public.lead_stars s
        where s.lead_id = l.id and s.user_id = (select auth.uid())))
      and ($13::public.lead_temperature is null or l.temperature = $13)
  $w$;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_offset' using errcode = '22023';
  end if;
  if v_term is not null and char_length(v_term) > 100 then
    raise exception 'search_too_long' using errcode = '22023';
  end if;
  if v_dir not in ('asc', 'desc') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  v_order := case p_sort
    when 'created_at' then 'l.created_at'
    when 'updated_at' then 'l.updated_at'
    when 'name' then 'lower(l.name)'
    when 'status' then 'ps.position'
    when 'next_follow_up' then 'nf.next_due'
    else null end;
  if v_order is null then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if p_sort = 'status' then
    v_sort_join := 'left join public.pipeline_stages ps on ps.id = l.stage_id';
  elsif p_sort = 'next_follow_up' then
    v_sort_join := v_next_due;
  end if;

  if v_role <> 'admin' then
    -- Sales scope is enforced by RLS; owner filtering and archive views are admin-only.
    p_owner_id := null;
    p_archived := false;
  end if;
  p_starred_only := coalesce(p_starred_only, false);

  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  execute 'select count(*) from public.leads l ' || v_where
    into v_total
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature;

  -- Pinned leads come first in every view (most recently pinned on top).
  execute format($q$
    with ids as (
      select l.id, st.pinned_at as star_pinned_at, st.lead_id is not null as is_starred, %1$s as sort_key
      from public.leads l
      %2$s
      left join public.lead_stars st on st.lead_id = l.id and st.user_id = (select auth.uid())
      %3$s
      order by st.pinned_at desc nulls last, %1$s %4$s nulls last, l.id %4$s
      limit $10 offset $11
    ),
    page as (
      select ids.*, row_number() over (order by ids.star_pinned_at desc nulls last, ids.sort_key %4$s nulls last, ids.id %4$s) as rn
      from ids
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'company_name', l.company_name, 'phone', l.phone, 'email', l.email, 'status', l.status, 'stage_id', l.stage_id,
      'source', l.source, 'temperature', l.temperature,
      'niche', jsonb_build_object('id', n.id, 'name', n.name),
      'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name),
      'next_follow_up_at', nf.next_due, 'overdue', coalesce(nf.overdue, false),
      'created_at', l.created_at, 'updated_at', l.updated_at,
      'archived_at', l.archived_at, 'version', l.version,
      'starred', p.is_starred, 'pinned_at', p.star_pinned_at
    ) order by p.rn), '[]'::jsonb)
    from page p
    join public.leads l on l.id = p.id
    %5$s
    join public.niches n on n.id = l.niche_id
    join public.profiles o on o.id = l.owner_id
  $q$, v_order, v_sort_join, v_where, v_dir, v_next_due)
    into v_items
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

-- Unchanged except the "due today" range (v_today_start).
create or replace function public.dashboard_admin(p_days integer default 30, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_today_start timestamptz := v_today::timestamp at time zone 'Asia/Kolkata';
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
        'active_leads', count(*) filter (where l.status = 'open'),
        'won_leads', count(*) filter (where l.status = 'won'),
        'lost_leads', count(*) filter (where l.status = 'lost'),
        'today_pending', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.state = 'pending' and f.due_at >= v_today_start and f.due_at < v_today_start + interval '1 day'),
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
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', s.cnt)
        order by s.position, s.id), '[]'::jsonb)
      from (
        select st.id, st.name, st.kind, st.color, st.position, count(*) as cnt
        from public.leads l join public.pipeline_stages st on st.id = l.stage_id
        where l.archived_at is null group by st.id
      ) s),
    'salespeople', (
      select coalesce(jsonb_agg(x order by (x ->> 'active')::int desc, x ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.display_name,
          'active', count(l.id) filter (where l.status = 'open'),
          'won', count(l.id) filter (where l.status = 'won'),
          'lost', count(l.id) filter (where l.status = 'lost')) as x
        from public.profiles p
        join public.leads l on l.owner_id = p.id and l.archived_at is null
        group by p.id, p.display_name
        order by count(l.id) filter (where l.status = 'open') desc, p.display_name
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

-- Unchanged except the "due today" range (v_today_start).
create or replace function public.dashboard_sales(p_days integer default 30, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_today date := private.ist_today();
  v_today_start timestamptz := v_today::timestamp at time zone 'Asia/Kolkata';
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
        'active_leads', count(*) filter (where l.status = 'open'),
        'won_leads', count(*) filter (where l.status = 'won'),
        'lost_leads', count(*) filter (where l.status = 'lost'),
        'today_pending', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.assignee_id = v_uid and f.state = 'pending' and f.due_at >= v_today_start and f.due_at < v_today_start + interval '1 day'),
        'overdue', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.assignee_id = v_uid and f.state = 'pending' and f.due_at < now()))
      from public.leads l where l.owner_id = v_uid and l.archived_at is null),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', s.cnt)
        order by s.position, s.id), '[]'::jsonb)
      from (
        select st.id, st.name, st.kind, st.color, st.position, count(*) as cnt
        from public.leads l join public.pipeline_stages st on st.id = l.stage_id
        where l.owner_id = v_uid and l.archived_at is null group by st.id
      ) s),
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
