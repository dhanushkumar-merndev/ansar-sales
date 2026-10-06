-- list_follow_ups: optional due-date range (half-open [p_due_from, p_due_to)),
-- applied on top of the view so the Follow-ups page can filter by date.

drop function if exists public.list_follow_ups(text, uuid, text, integer, integer);

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
    -- Starred: pinned first (latest pin on top), then pending before closed.
    -- Pending views: soonest first. History views: newest first. id is the tie-breaker.
    select fl.id, row_number() over (order by
      case when p_view = 'starred' then fl.pinned_at end desc nulls last,
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
      'lead', jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'status', l.status),
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

revoke all on function public.list_follow_ups(text, uuid, text, integer, integer, timestamptz, timestamptz) from public, anon;
grant execute on function public.list_follow_ups(text, uuid, text, integer, integer, timestamptz, timestamptz) to authenticated;
