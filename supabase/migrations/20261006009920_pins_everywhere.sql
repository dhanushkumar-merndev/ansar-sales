-- Pins work in every view, not only Starred: pinned leads and follow-ups come first
-- (latest pin on top) wherever the user's lists are shown. Filters still apply, so a
-- pinned row only appears when it matches the current view. Otherwise unchanged from 20261006009200.

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
  p_starred_only boolean default false
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
  v_dir text := lower(coalesce(p_dir, 'desc'));
  v_total bigint;
  v_items jsonb;
  v_pinned bigint;
  v_where text := $w$
    where (case when $9 then l.archived_at is not null else l.archived_at is null end)
      and ($1::text is null or l.name ilike $1 or l.email ilike $1 or ($2::text is not null and l.phone_normalized like $2))
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
    when 'status' then '(select s.position from public.pipeline_stages s where s.id = l.stage_id)'
    when 'next_follow_up' then 'nf.next_due'
    else null end;
  if v_order is null then
    raise exception 'invalid_sort' using errcode = '22023';
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
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only;

  -- Pinned leads come first in every view (most recently pinned on top).
  execute format($q$
    with page as (
      select l.*, nf.next_due, nf.overdue, st.pinned_at as star_pinned_at, st.lead_id is not null as is_starred,
        row_number() over (order by st.pinned_at desc nulls last, %s %s nulls last, l.id %s) as rn
      from public.leads l
      left join lateral (
        select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
      left join public.lead_stars st on st.lead_id = l.id and st.user_id = (select auth.uid())
      %s
      order by st.pinned_at desc nulls last, %s %s nulls last, l.id %s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'phone', p.phone, 'email', p.email, 'status', p.status, 'stage_id', p.stage_id,
      'source', p.source,
      'niche', jsonb_build_object('id', n.id, 'name', n.name),
      'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name),
      'next_follow_up_at', p.next_due, 'overdue', coalesce(p.overdue, false),
      'created_at', p.created_at, 'updated_at', p.updated_at,
      'archived_at', p.archived_at, 'version', p.version,
      'starred', p.is_starred, 'pinned_at', p.star_pinned_at
    ) order by p.rn), '[]'::jsonb)
    from page p
    join public.niches n on n.id = p.niche_id
    join public.profiles o on o.id = p.owner_id
  $q$, v_order, v_dir, v_dir, v_where, v_order, v_dir, v_dir)
    into v_items
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

create or replace function public.list_follow_ups(
  p_view text default 'pending',
  p_assignee_id uuid default null,
  p_search text default null,
  p_limit integer default 20,
  p_offset integer default 0,
  p_due_from timestamptz default null,
  p_due_to timestamptz default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_uid uuid := (select auth.uid());
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_tomorrow_start timestamptz := v_today_start + interval '1 day';
  v_total bigint;
  v_items jsonb;
  v_pinned bigint;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_view not in ('overdue', 'today', 'upcoming', 'pending', 'completed', 'cancelled', 'starred') then
    raise exception 'invalid_view' using errcode = '22023';
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
  if p_due_from is not null and p_due_to is not null and p_due_to <= p_due_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_role <> 'admin' then
    p_assignee_id := null;
  end if;
  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select f.id, f.state, st.pinned_at,
      case when p_view = 'completed' then f.completed_at
           when p_view = 'cancelled' then f.cancelled_at
           else f.due_at end as sort_ts
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id and l.archived_at is null
    left join public.follow_up_stars st on st.follow_up_id = f.id and st.user_id = v_uid
    where (p_assignee_id is null or f.assignee_id = p_assignee_id)
      and (v_pattern is null or l.name ilike v_pattern or f.task ilike v_pattern)
      and (p_due_from is null or f.due_at >= p_due_from)
      and (p_due_to is null or f.due_at < p_due_to)
      and case p_view
        when 'overdue' then f.state = 'pending' and f.due_at < now()
        when 'today' then f.state = 'pending' and f.due_at >= v_today_start and f.due_at < v_tomorrow_start
        when 'upcoming' then f.state = 'pending' and f.due_at >= v_tomorrow_start
        when 'pending' then f.state = 'pending'
        when 'completed' then f.state = 'completed'
        when 'starred' then st.follow_up_id is not null
        else f.state = 'cancelled' end
  ),
  numbered as (
    -- Pinned first in every view (latest pin on top); Starred then lists pending before closed.
    -- Pending views: soonest first. History views: newest first. id is the tie-breaker.
    select fl.id, row_number() over (order by
      fl.pinned_at desc nulls last,
      case when p_view = 'starred' then fl.state <> 'pending' end asc,
      case when p_view in ('completed', 'cancelled') then null else fl.sort_ts end asc,
      case when p_view in ('completed', 'cancelled') then fl.sort_ts end desc,
      case when p_view in ('completed', 'cancelled') then null else fl.id end asc,
      case when p_view in ('completed', 'cancelled') then fl.id end desc) as rn
    from filtered fl
  ),
  page as (
    select n.id, n.rn from numbered n where n.rn > p_offset and n.rn <= p_offset + p_limit
  )
  select
    (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'task', f.task, 'due_at', f.due_at, 'state', f.state, 'outcome', f.outcome,
      'completed_at', f.completed_at, 'cancelled_at', f.cancelled_at, 'revision', f.revision,
      'overdue', f.state = 'pending' and f.due_at < now(),
      'lead', jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'status', l.status, 'stage_id', l.stage_id),
      'assignee', jsonb_build_object('id', a.id, 'display_name', a.display_name),
      'reminder', (
        select jsonb_build_object('state', d.state, 'attempts', d.attempts, 'last_error', d.last_error, 'sent_at', d.sent_at)
        from public.reminder_deliveries d
        where d.follow_up_id = f.id and d.revision = f.revision
        limit 1),
      'starred', st.follow_up_id is not null, 'pinned_at', st.pinned_at
    ) order by pg.rn), '[]'::jsonb)
    from page pg
    join public.follow_ups f on f.id = pg.id
    join public.leads l on l.id = f.lead_id
    join public.profiles a on a.id = f.assignee_id
    left join public.follow_up_stars st on st.follow_up_id = f.id and st.user_id = v_uid)
  into v_total, v_items;

  select count(*) into v_pinned from public.follow_up_stars s
    where s.user_id = v_uid and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;
