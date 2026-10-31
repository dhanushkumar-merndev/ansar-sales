-- Leads: Sl No range summary. Double-click two Sl Nos on the Leads list and see how many of those leads are in
-- each stage and temperature.
--
-- * private.lead_list_page: the list's filters, checks and order in one place (moved out of list_leads from
--   20261008005500, unchanged). Returns the ordered ids of a slice and, if asked, the total.
-- * list_leads: same arguments and JSON as 5500; builds its rows from lead_list_page.
-- * lead_range_summary: Sl No p_from..p_to (1-based, inclusive, the same order as the list) counted by stage and
--   temperature. Security invoker: RLS keeps Sales to their own leads.
-- Later changes to the list's filters or order start from lead_list_page here.

create function private.lead_list_page(
  p_search text,
  p_stage_ids uuid[],
  p_niche_id uuid,
  p_owner_id uuid,
  p_created_from timestamptz,
  p_created_to timestamptz,
  p_overdue_only boolean,
  p_archived boolean,
  p_sort text,
  p_dir text,
  p_starred_only boolean,
  p_temperature public.lead_temperature,
  p_starred_by uuid,
  p_limit integer,
  p_offset integer,
  p_with_total boolean
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_uid uuid := (select auth.uid());
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_digits text;
  v_order text;
  v_sort_join text := '';
  v_dir text := lower(coalesce(p_dir, 'desc'));
  v_viewer uuid;
  v_other boolean;
  v_new_stage uuid;
  v_bucket text := '0';
  v_pin_key text := 'm.pinned_at';
  v_total bigint;
  v_rows jsonb;
  v_marks text := 'with marks as materialized (select * from private.lead_marks($14)) ';
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
        select 1 from marks mk
        where mk.lead_id = l.id and (mk.starred or ($15 and mk.pinned_at is not null))))
      and ($13::public.lead_temperature is null or l.temperature = $13)
  $w$;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
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
    v_sort_join := $j$
      left join lateral (
        select min(f.due_at) as next_due
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
    $j$;
  end if;

  if v_role <> 'admin' then
    -- Sales scope is enforced by RLS; owner filtering, archive views and other people's stars are admin-only.
    p_owner_id := null;
    p_archived := false;
    p_starred_by := null;
  end if;
  p_starred_only := coalesce(p_starred_only, false);
  v_viewer := coalesce(p_starred_by, v_uid);
  v_other := v_viewer is distinct from v_uid;
  -- Checked here too: the marks CTE only runs when a lead row needs it.
  if v_other and not exists (select 1 from public.list_lead_staff() s where s.id = v_viewer) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Default sort: leads still in the first open stage ("New") first, newest first; then pins; then the rest.
  if p_sort = 'created_at' and v_dir = 'desc' then
    select s.id into v_new_stage from public.pipeline_stages s
      where s.company_id = private.current_company_id() and s.archived_at is null and s.kind = 'open'
      order by s.position, s.id limit 1;
    if v_new_stage is not null then
      v_bucket := format('case when l.stage_id = %L::uuid then 0 else 1 end', v_new_stage);
      v_pin_key := format('case when l.stage_id = %L::uuid then null else m.pinned_at end', v_new_stage);
    end if;
  end if;

  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  if coalesce(p_with_total, false) then
    execute v_marks || 'select count(*) from public.leads l ' || v_where
      into v_total
      using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
            coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature,
            v_viewer, v_other;
  end if;

  execute v_marks || format($q$
    , ids as (
      select l.id, m.pinned_at as star_pinned_at, coalesce(m.starred, false) as is_starred,
             %5$s as bucket, %6$s as pin_key, %1$s as sort_key
      from public.leads l
      %2$s
      left join marks m on m.lead_id = l.id
      %3$s
      order by 4, 5 desc nulls last, 6 %4$s nulls last, l.id %4$s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', ids.id, 'starred', ids.is_starred, 'pinned_at', ids.star_pinned_at)
      order by ids.bucket, ids.pin_key desc nulls last, ids.sort_key %4$s nulls last, ids.id %4$s), '[]'::jsonb)
    from ids
  $q$, v_order, v_sort_join, v_where, v_dir, v_bucket, v_pin_key)
    into v_rows
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature,
          v_viewer, v_other;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

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
  p_temperature public.lead_temperature default null,
  p_starred_by uuid default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_page jsonb;
  v_items jsonb;
  v_pinned bigint;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  v_page := private.lead_list_page(p_search, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
    p_overdue_only, p_archived, p_sort, p_dir, p_starred_only, p_temperature, p_starred_by, p_limit, p_offset, true);

  -- Next follow-up, niche and owner only for the page's <= 100 rows.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'company_name', l.company_name, 'phone', l.phone, 'email', l.email, 'status', l.status, 'stage_id', l.stage_id,
      'source', l.source, 'temperature', l.temperature,
      'niche', jsonb_build_object('id', n.id, 'name', n.name),
      'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name),
      'next_follow_up_at', nf.next_due, 'overdue', coalesce(nf.overdue, false),
      'created_at', l.created_at, 'updated_at', l.updated_at,
      'archived_at', l.archived_at, 'version', l.version,
      'starred', r.value -> 'starred', 'pinned_at', r.value -> 'pinned_at'
    ) order by r.ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_page -> 'rows') with ordinality as r(value, ord)
    join public.leads l on l.id = (r.value ->> 'id')::uuid
    left join lateral (
      select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
      from public.follow_ups f
      where f.lead_id = l.id and f.state = 'pending'
    ) nf on true
    join public.niches n on n.id = l.niche_id
    join public.profiles o on o.id = l.owner_id;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', (v_page ->> 'total')::bigint, 'pinned_count', v_pinned);
end $$;

-- Sl No p_from..p_to of the list with these filters and this sort, counted by stage and temperature.
create function public.lead_range_summary(
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
  p_starred_only boolean default false,
  p_temperature public.lead_temperature default null,
  p_starred_by uuid default null,
  p_from integer default null,
  p_to integer default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_page jsonb;
  v_result jsonb;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_from is null or p_to is null or p_from < 1 or p_to < p_from or p_to - p_from >= 10000 or p_from > 1000001 then
    raise exception 'invalid_sl_range' using errcode = '22023';
  end if;

  v_page := private.lead_list_page(p_search, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
    p_overdue_only, p_archived, p_sort, p_dir, p_starred_only, p_temperature, p_starred_by, p_to - p_from + 1, p_from - 1, false);

  with r as (
    select l.stage_id, l.temperature
    from jsonb_array_elements(v_page -> 'rows') as e(value)
    join public.leads l on l.id = (e.value ->> 'id')::uuid
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'count', (select count(*) from r),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', c.cnt) order by s.position, s.id)
      from (select r.stage_id, count(*) as cnt from r group by r.stage_id) c
      join public.pipeline_stages s on s.id = c.stage_id), '[]'::jsonb),
    'temperatures', (
      select jsonb_build_object(
        'hot', count(*) filter (where r.temperature = 'hot'),
        'medium', count(*) filter (where r.temperature = 'medium'),
        'cold', count(*) filter (where r.temperature = 'cold'),
        'none', count(*) filter (where r.temperature is null))
      from r))
  into v_result;
  return v_result;
end $$;

revoke all on function
  private.lead_list_page(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, boolean),
  public.lead_range_summary(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer)
from public, anon;
grant execute on function
  private.lead_list_page(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, boolean),
  public.lead_range_summary(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer)
to authenticated;
