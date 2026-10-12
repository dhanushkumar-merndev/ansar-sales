-- ---------------------------------------------------------------------------
-- Projects as folders: year → month (by start date) → projects. project_months counts the projects
-- of each month under the same filters and access as list_projects (status, late only); list_projects
-- gains a start-date range (p_from inclusive, p_to exclusive) and a 'start' sort for one month's folder.
-- ---------------------------------------------------------------------------

drop function public.list_projects(text, text, uuid, boolean, text, integer, integer);

create function public.list_projects(
  p_search text default null,
  p_status text default 'open',
  p_member_id uuid default null,
  p_late_only boolean default false,
  p_sort text default 'end_date',
  p_limit integer default 20,
  p_offset integer default 0,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_today date := private.ist_today();
  v_total bigint;
  v_items jsonb;
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('account') or private.has_role('architect_manager')
     or private.has_role('landscape_designer') or private.has_role('execution')) then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if p_status not in ('open', 'active', 'on_hold', 'completed', 'cancelled', 'all') or p_sort not in ('end_date', 'created', 'code', 'name', 'start') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;
  if not private.is_admin() then
    p_member_id := null;
  end if;

  with filtered as (
    select p.* from public.projects p
    where p.archived_at is null
      and case p_status when 'all' then true when 'open' then p.status in ('active', 'on_hold') else p.status::text = p_status end
      and (v_pattern is null or p.name ilike v_pattern or p.client_name ilike v_pattern or p.code ilike v_pattern
           or p.client_phone like '%' || nullif(regexp_replace(v_term, '\D', '', 'g'), '') || '%')
      and (p_from is null or p.start_date >= p_from)
      and (p_to is null or p.start_date < p_to)
      and (p_member_id is null or exists (select 1 from public.project_members m
        where m.project_id = p.id and m.user_id = p_member_id and m.removed_at is null))
      and (not coalesce(p_late_only, false) or exists (select 1 from public.project_phases ph
        where ph.project_id = p.id and ph.archived_at is null and ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today))
  ), page as (
    select f.*, row_number() over (order by
      case when p_sort = 'end_date' then f.end_date end asc,
      case when p_sort = 'created' then f.created_at end desc,
      case when p_sort = 'code' then f.code end desc,
      case when p_sort = 'name' then lower(f.name) end asc,
      case when p_sort = 'start' then f.start_date end asc,
      f.id) as rn
    from filtered f
    order by rn
    limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'code', pg.code, 'name', pg.name, 'client_name', pg.client_name, 'client_phone', pg.client_phone,
      'status', pg.status, 'color', pg.color, 'start_date', pg.start_date, 'end_date', pg.end_date, 'lead_id', pg.lead_id,
      'site_address', pg.site_address, 'updated_at', pg.updated_at,
      'phases_total', s.total, 'phases_done', s.done, 'late_phases', s.late, 'max_late_days', s.max_late,
      'current_phase', (select jsonb_build_object('id', ph.id, 'name', ph.name, 'category', ph.category, 'status', ph.status,
          'deadline', ph.deadline, 'color', ph.color)
        from public.project_phases ph
        where ph.project_id = pg.id and ph.archived_at is null and ph.status not in ('done', 'skipped')
        order by ph.planned_start, ph.position, ph.id limit 1),
      'team', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'display_name', pr.display_name, 'role', m.member_role)
          order by m.member_role, pr.display_name)
        from public.project_members m join public.profiles pr on pr.id = m.user_id
        where m.project_id = pg.id and m.removed_at is null and m.member_role <> 'client'), '[]'::jsonb)
    ) order by pg.rn), '[]'::jsonb)
    from page pg
    cross join lateral (
      select count(*) as total,
        count(*) filter (where ph.status in ('done', 'skipped')) as done,
        count(*) filter (where ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today) as late,
        coalesce(max(case when ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today then v_today - ph.deadline end), 0) as max_late
      from public.project_phases ph where ph.project_id = pg.id and ph.archived_at is null
    ) s)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.project_months(p_status text default 'open', p_late_only boolean default false)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today date := private.ist_today();
begin
  if not private.company_has('projects') or not (private.is_admin() or private.has_role('account') or private.has_role('architect_manager')
     or private.has_role('landscape_designer') or private.has_role('execution')) then
    perform private.raise_forbidden();
  end if;
  if p_status not in ('open', 'active', 'on_hold', 'completed', 'cancelled', 'all') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('year', m.y, 'month', m.mo, 'total', m.total, 'late', m.late, 'active', m.active, 'colors', m.colors)
      order by m.y desc, m.mo desc)
    from (
      select extract(year from x.start_date)::int as y, extract(month from x.start_date)::int as mo,
        count(*)::int as total, count(*) filter (where x.late)::int as late, count(*) filter (where x.status = 'active')::int as active,
        to_jsonb((array_agg(x.color order by x.start_date, x.id))[1:4]) as colors
      from (
        -- RLS on projects decides what each person sees (admin: all; team: their projects).
        select p.id, p.start_date, p.status, p.color,
          exists (select 1 from public.project_phases ph where ph.project_id = p.id and ph.archived_at is null
            and ph.status not in ('done', 'skipped', 'in_review') and ph.deadline < v_today) as late
        from public.projects p
        where p.archived_at is null
          and case p_status when 'all' then true when 'open' then p.status in ('active', 'on_hold') else p.status::text = p_status end
      ) x
      where not coalesce(p_late_only, false) or x.late
      group by 1, 2
    ) m), '[]'::jsonb);
end $$;

revoke all on function public.list_projects(text, text, uuid, boolean, text, integer, integer, date, date) from public, anon;
revoke all on function public.project_months(text, boolean) from public, anon;
grant execute on function public.list_projects(text, text, uuid, boolean, text, integer, integer, date, date) to authenticated;
grant execute on function public.project_months(text, boolean) to authenticated;
