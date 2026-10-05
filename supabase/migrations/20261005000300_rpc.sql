-- Simple CRM: RPC functions.
-- Ordinary CRM RPCs are SECURITY INVOKER so the caller's RLS applies.
-- SECURITY DEFINER is used only where a narrow cross-scope check is required
-- (duplicate detection, admin user management, Telegram linking, reminder worker).

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------

-- Returns whether another lead has this normalized phone, without disclosing
-- restricted details: the lead id is returned only when the caller can open it.
create function public.check_duplicate_phone(p_phone_normalized text, p_exclude_lead_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ids uuid[];
  v_visible uuid;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select array_agg(l.id) into v_ids from (
    select l.id from public.leads l
    where l.phone_normalized = p_phone_normalized
      and l.archived_at is null
      and (p_exclude_lead_id is null or l.id <> p_exclude_lead_id)
    limit 20
  ) l;
  if v_ids is null then
    return jsonb_build_object('duplicate', false);
  end if;
  select id into v_visible from unnest(v_ids) as id where private.can_access_lead(id) limit 1;
  return jsonb_build_object('duplicate', true, 'visible_lead_id', v_visible);
end $$;

create function public.create_lead(
  p_name text,
  p_phone text,
  p_phone_normalized text,
  p_email text default null,
  p_niche_id uuid default null,
  p_new_niche text default null,
  p_status public.lead_status default 'new',
  p_owner_id uuid default null,
  p_note text default null,
  p_follow_up_at timestamptz default null,
  p_follow_up_task text default null,
  p_allow_duplicate boolean default false
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_niche uuid;
  v_lead uuid;
  v_owner uuid;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;

  if not coalesce(p_allow_duplicate, false)
     and (public.check_duplicate_phone(p_phone_normalized) ->> 'duplicate')::boolean then
    raise exception 'duplicate_phone' using errcode = '23505';
  end if;

  v_niche := private.resolve_niche(p_niche_id, p_new_niche);
  v_owner := case when v_role = 'admin' then coalesce(p_owner_id, (select auth.uid())) else (select auth.uid()) end;

  insert into public.leads (name, phone, phone_normalized, email, niche_id, status, owner_id, created_by)
  values (p_name, p_phone, p_phone_normalized, p_email, v_niche, coalesce(p_status, 'new'), v_owner, (select auth.uid()))
  returning id into v_lead;

  if private.clean_label(p_note) is not null then
    insert into public.lead_activities (lead_id, type, body, actor_id)
    values (v_lead, 'note', p_note, (select auth.uid()));
  end if;

  if p_follow_up_at is not null then
    insert into public.follow_ups (lead_id, task, due_at, created_by)
    values (v_lead, coalesce(private.clean_label(p_follow_up_task), 'Follow up'), p_follow_up_at, (select auth.uid()));
  end if;

  return v_lead;
end $$;

-- Optimistic-concurrency edit of contact fields and niche. Returns the new version.
create function public.update_lead(
  p_id uuid,
  p_version integer,
  p_name text,
  p_phone text,
  p_phone_normalized text,
  p_email text default null,
  p_niche_id uuid default null,
  p_new_niche text default null,
  p_allow_duplicate boolean default false
)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_niche uuid;
  v_version integer;
  v_current_phone text;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select l.phone_normalized into v_current_phone from public.leads l where l.id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_current_phone <> p_phone_normalized and not coalesce(p_allow_duplicate, false)
     and (public.check_duplicate_phone(p_phone_normalized, p_id) ->> 'duplicate')::boolean then
    raise exception 'duplicate_phone' using errcode = '23505';
  end if;

  v_niche := private.resolve_niche(p_niche_id, p_new_niche);

  update public.leads l
    set name = p_name, phone = p_phone, phone_normalized = p_phone_normalized,
        email = p_email, niche_id = v_niche
    where l.id = p_id and l.version = p_version
    returning l.version into v_version;
  if v_version is null then
    raise exception 'version_conflict' using errcode = '40001';
  end if;
  return v_version;
end $$;

-- Server-side filtered, sorted, offset-paginated lead list with an authorized total.
create function public.list_leads(
  p_search text default null,
  p_statuses public.lead_status[] default null,
  p_niche_id uuid default null,
  p_owner_id uuid default null,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_overdue_only boolean default false,
  p_archived boolean default false,
  p_sort text default 'created_at',
  p_dir text default 'desc',
  p_limit integer default 20,
  p_offset integer default 0
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
  v_where text := $w$
    where (case when $9 then l.archived_at is not null else l.archived_at is null end)
      and ($1::text is null or l.name ilike $1 or l.email ilike $1 or ($2::text is not null and l.phone_normalized like $2))
      and ($3::public.lead_status[] is null or l.status = any($3))
      and ($4::uuid is null or l.niche_id = $4)
      and ($5::uuid is null or l.owner_id = $5)
      and ($6::timestamptz is null or l.created_at >= $6)
      and ($7::timestamptz is null or l.created_at < $7)
      and (not $8 or exists (
        select 1 from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending' and f.due_at < now()))
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
    when 'status' then 'l.status'
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

  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  execute 'select count(*) from public.leads l ' || v_where
    into v_total
    using v_pattern, v_digits, p_statuses, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false);

  execute format($q$
    with page as (
      select l.*, nf.next_due, nf.overdue,
        row_number() over (order by %s %s nulls last, l.id %s) as rn
      from public.leads l
      left join lateral (
        select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
      %s
      order by %s %s nulls last, l.id %s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'phone', p.phone, 'email', p.email, 'status', p.status,
      'niche', jsonb_build_object('id', n.id, 'name', n.name),
      'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name),
      'next_follow_up_at', p.next_due, 'overdue', coalesce(p.overdue, false),
      'created_at', p.created_at, 'updated_at', p.updated_at,
      'archived_at', p.archived_at, 'version', p.version
    ) order by p.rn), '[]'::jsonb)
    from page p
    join public.niches n on n.id = p.niche_id
    join public.profiles o on o.id = p.owner_id
  $q$, v_order, v_dir, v_dir, v_where, v_order, v_dir, v_dir)
    into v_items
    using v_pattern, v_digits, p_statuses, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset;

  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.correct_note(p_note_id uuid, p_body text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_note public.lead_activities%rowtype;
  v_body text := btrim(coalesce(p_body, ''));
begin
  select * into v_note from public.lead_activities a where a.id = p_note_id and a.type = 'note';
  if not found or not private.can_access_lead(v_note.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_note.actor_id <> (select auth.uid()) and not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if v_body = '' or char_length(v_body) > 5000 then
    raise exception 'note_required' using errcode = '22023';
  end if;
  if v_body = v_note.body then
    return;
  end if;
  -- Keep the previous text in the history before correcting the note in place.
  insert into public.lead_activities (lead_id, actor_id, type, meta)
  values (v_note.lead_id, (select auth.uid()), 'note_corrected',
    jsonb_build_object('note_id', v_note.id, 'previous_body', v_note.body));
  update public.lead_activities set body = v_body, edited_at = now() where id = v_note.id;
end $$;

-- ---------------------------------------------------------------------------
-- Follow-ups
-- ---------------------------------------------------------------------------
create function public.complete_follow_up(
  p_id uuid,
  p_outcome text default null,
  p_next_due_at timestamptz default null,
  p_next_task text default null
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_lead uuid;
  v_next uuid;
begin
  update public.follow_ups f set state = 'completed', outcome = p_outcome
    where f.id = p_id and f.state = 'pending'
    returning f.lead_id into v_lead;
  if v_lead is null then
    raise exception 'not_found_or_closed' using errcode = 'P0002';
  end if;
  if p_next_due_at is not null then
    insert into public.follow_ups (lead_id, task, due_at, created_by)
    values (v_lead, coalesce(private.clean_label(p_next_task), 'Follow up'), p_next_due_at, (select auth.uid()))
    returning id into v_next;
  end if;
  return v_next;
end $$;

-- p_view: overdue | today | upcoming | pending | completed | cancelled
create function public.list_follow_ups(
  p_view text default 'pending',
  p_assignee_id uuid default null,
  p_search text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_tomorrow_start timestamptz := v_today_start + interval '1 day';
  v_total bigint;
  v_items jsonb;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_view not in ('overdue', 'today', 'upcoming', 'pending', 'completed', 'cancelled') then
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
  if v_role <> 'admin' then
    p_assignee_id := null;
  end if;
  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select f.id,
      case when p_view = 'completed' then f.completed_at
           when p_view = 'cancelled' then f.cancelled_at
           else f.due_at end as sort_ts
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id and l.archived_at is null
    where (p_assignee_id is null or f.assignee_id = p_assignee_id)
      and (v_pattern is null or l.name ilike v_pattern or f.task ilike v_pattern)
      and case p_view
        when 'overdue' then f.state = 'pending' and f.due_at < now()
        when 'today' then f.state = 'pending' and f.due_at >= v_today_start and f.due_at < v_tomorrow_start
        when 'upcoming' then f.state = 'pending' and f.due_at >= v_tomorrow_start
        when 'pending' then f.state = 'pending'
        when 'completed' then f.state = 'completed'
        else f.state = 'cancelled' end
  ),
  numbered as (
    -- Pending views: soonest first. History views: newest first. id is the tie-breaker.
    select fl.id, row_number() over (order by
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
        limit 1)
    ) order by pg.rn), '[]'::jsonb)
    from page pg
    join public.follow_ups f on f.id = pg.id
    join public.leads l on l.id = f.lead_id
    join public.profiles a on a.id = f.assignee_id)
  into v_total, v_items;

  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- ---------------------------------------------------------------------------
-- Niches (admin maintenance)
-- ---------------------------------------------------------------------------
create function public.merge_niches(p_source_id uuid, p_target_id uuid)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_source_id = p_target_id then
    raise exception 'invalid_merge' using errcode = '22023';
  end if;
  if not exists (select 1 from public.niches n where n.id = p_target_id and n.archived_at is null) then
    raise exception 'niche_not_found' using errcode = 'P0002';
  end if;
  update public.leads set niche_id = p_target_id where niche_id = p_source_id;
  get diagnostics v_count = row_count;
  update public.niches set archived_at = now() where id = p_source_id;
  -- merged_into_id is not user-updatable; set it with definer rights via helper.
  perform private.set_niche_merged(p_source_id, p_target_id);
  return v_count;
end $$;

create function private.set_niche_merged(p_source_id uuid, p_target_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  update public.niches set merged_into_id = p_target_id where id = p_source_id;
  -- Re-point older merges so lookups never chain.
  update public.niches set merged_into_id = p_target_id where merged_into_id = p_source_id;
end $$;

grant execute on function private.set_niche_merged(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Admin user management (Auth operations happen server-side; this keeps the
-- authoritative profile changes, the last-admin rule and the audit in SQL).
-- ---------------------------------------------------------------------------
create function public.admin_update_user(
  p_user_id uuid,
  p_display_name text default null,
  p_role public.app_role default null,
  p_is_active boolean default null
)
returns public.profiles
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.profiles%rowtype;
  v_new public.profiles%rowtype;
  v_active_admins integer;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;

  -- Serialize admin changes so two concurrent demotions cannot remove the last admin.
  perform 1 from public.profiles where role = 'admin' and is_active for update;

  select * into v_old from public.profiles where id = p_user_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  update public.profiles set
    display_name = coalesce(private.clean_label(p_display_name), display_name),
    role = coalesce(p_role, role),
    is_active = coalesce(p_is_active, is_active)
  where id = p_user_id
  returning * into v_new;

  select count(*) into v_active_admins from public.profiles where role = 'admin' and is_active;
  if v_active_admins < 1 then
    raise exception 'last_admin' using errcode = '23514';
  end if;

  if v_new.role not in ('sales', 'admin') and v_new.role <> v_old.role and exists (
    select 1 from public.leads l where l.owner_id = p_user_id and l.archived_at is null
  ) then
    raise exception 'reassign_leads_first' using errcode = '23514';
  end if;

  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, 'user_updated', jsonb_strip_nulls(jsonb_build_object(
    'display_name', case when v_new.display_name <> v_old.display_name then jsonb_build_object('from', v_old.display_name, 'to', v_new.display_name) end,
    'role', case when v_new.role <> v_old.role then jsonb_build_object('from', v_old.role, 'to', v_new.role) end,
    'is_active', case when v_new.is_active <> v_old.is_active then jsonb_build_object('from', v_old.is_active, 'to', v_new.is_active) end
  )));
  return v_new;
end $$;

create function public.admin_list_users(
  p_search text default null,
  p_role public.app_role default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select p.* from public.profiles p
    where (p_role is null or p.role = p_role)
      and (v_pattern is null or p.username ilike v_pattern or p.display_name ilike v_pattern)
  ), page as (
    select f.*, row_number() over (order by f.is_active desc, lower(f.display_name), f.id) as rn
    from filtered f
    order by rn
    limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'username', pg.username, 'display_name', pg.display_name, 'role', pg.role,
      'is_active', pg.is_active, 'created_at', pg.created_at,
      'owned_active_leads', (select count(*) from public.leads l where l.owner_id = pg.id and l.archived_at is null)
    ) order by pg.rn), '[]'::jsonb) from page pg)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.admin_log_password_reset(p_user_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  insert into public.admin_audit_log (actor_id, target_user_id, action)
  values ((select auth.uid()), p_user_id, 'password_reset');
end $$;

-- ---------------------------------------------------------------------------
-- Dashboards (aggregates under the caller's permissions)
-- ---------------------------------------------------------------------------
create function private.ist_today()
returns date
language sql stable
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

create function public.dashboard_admin(p_days integer default 30)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_from date;
  v_result jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  p_days := least(greatest(coalesce(p_days, 30), 7), 365);
  v_from := v_today - (p_days - 1);

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_today, 'days', p_days),
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
      from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') as d(day)
      left join (
        select (l.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as cnt
        from public.leads l
        where l.archived_at is null and l.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
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

create function public.dashboard_sales(p_days integer default 30)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_today date := private.ist_today();
  v_from date;
  v_result jsonb;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  p_days := least(greatest(coalesce(p_days, 30), 7), 365);
  v_from := v_today - (p_days - 1);

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_today, 'days', p_days),
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
      from generate_series(v_from::timestamp, v_today::timestamp, interval '1 day') as d(day)
      left join (
        select (a.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as cnt
        from public.lead_activities a
        where a.actor_id = v_uid and a.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
        group by 1
      ) c on c.day = d.day::date)
  ) into v_result;
  return v_result;
end $$;

create function public.dashboard_finance(p_months integer default 12)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_month date := date_trunc('month', private.ist_today())::date;
  v_from date;
  v_result jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  p_months := least(greatest(coalesce(p_months, 12), 3), 36);
  v_from := (v_month - make_interval(months => p_months - 1))::date;

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', (v_month + interval '1 month - 1 day')::date, 'months', p_months),
    'total_capital', (select coalesce(sum(c.amount), 0) from public.capital_entries c where c.archived_at is null),
    'current_month', v_month,
    'current_month_expenses', (
      select coalesce(sum(e.amount), 0) from public.expenses e
      where e.archived_at is null and e.expense_date >= v_month and e.expense_date < (v_month + interval '1 month')::date),
    'monthly', (
      select coalesce(jsonb_agg(jsonb_build_object('month', m.month::date, 'total', coalesce(t.total, 0)) order by m.month), '[]'::jsonb)
      from generate_series(v_from::timestamp, v_month::timestamp, interval '1 month') as m(month)
      left join (
        select date_trunc('month', e.expense_date)::date as month, sum(e.amount) as total
        from public.expenses e
        where e.archived_at is null and e.expense_date >= v_from
        group by 1
      ) t on t.month = m.month::date),
    'categories', (
      select coalesce(jsonb_agg(jsonb_build_object('category', t.category, 'total', t.total) order by t.total desc), '[]'::jsonb)
      from (
        select e.category, sum(e.amount) as total from public.expenses e
        where e.archived_at is null and e.expense_date >= v_from
        group by e.category
      ) t)
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Telegram linking
-- ---------------------------------------------------------------------------

-- Creates an opaque, single-use, 15 minute token for the signed-in user.
-- Only its SHA-256 hash is stored.
create function public.create_telegram_link_token()
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_token text;
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  delete from public.telegram_link_tokens t
    where t.user_id = v_uid or t.expires_at < now() - interval '1 day';
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.telegram_link_tokens (token_hash, user_id, expires_at)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_uid, now() + interval '15 minutes');
  return v_token;
end $$;

-- Called only by the verified Telegram webhook (service role).
create function public.consume_telegram_link_token(p_token text, p_chat_id bigint, p_telegram_username text default null)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_user uuid;
  v_name text;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' or p_chat_id is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  update public.telegram_link_tokens t
    set consumed_at = now()
    where t.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
      and t.consumed_at is null and t.expires_at > now()
    returning t.user_id into v_user;
  if v_user is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_or_expired');
  end if;
  select p.display_name into v_name from public.profiles p where p.id = v_user and p.is_active;
  if v_name is null then
    return jsonb_build_object('ok', false, 'reason', 'inactive');
  end if;
  -- A Telegram chat can belong to one CRM user at a time.
  delete from public.telegram_connections c where c.chat_id = p_chat_id and c.user_id <> v_user;
  insert into public.telegram_connections (user_id, chat_id, telegram_username, status, last_error, connected_at)
  values (v_user, p_chat_id, left(p_telegram_username, 64), 'connected', null, now())
  on conflict (user_id) do update set
    chat_id = excluded.chat_id, telegram_username = excluded.telegram_username,
    status = 'connected', last_error = null, connected_at = now();
  return jsonb_build_object('ok', true, 'display_name', v_name);
end $$;

create function public.disconnect_telegram()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if private.app_role() is null then
    perform private.raise_forbidden();
  end if;
  delete from public.telegram_connections where user_id = (select auth.uid());
end $$;

-- ---------------------------------------------------------------------------
-- Reminder worker (service role only)
-- ---------------------------------------------------------------------------
create function public.claim_due_reminders(p_limit integer default 25, p_lease_seconds integer default 120)
returns table (
  delivery_id uuid,
  lease_token uuid,
  chat_id bigint,
  lead_id uuid,
  lead_name text,
  lead_phone text,
  task text,
  due_at timestamptz,
  attempts integer
)
language plpgsql volatile security definer set search_path = ''
as $$
#variable_conflict use_column
declare
  v_max_attempts constant integer := 5;
  r record;
  v_reason text;
  v_token uuid;
begin
  p_limit := least(greatest(coalesce(p_limit, 25), 1), 100);
  p_lease_seconds := least(greatest(coalesce(p_lease_seconds, 120), 30), 900);

  for r in
    select d.id, d.revision, d.attempts, d.recipient_id,
           f.id as follow_up_id, f.state as fu_state, f.revision as fu_revision, f.assignee_id, f.task as fu_task, f.due_at as fu_due,
           l.id as l_id, l.name as l_name, l.phone as l_phone, l.owner_id, l.archived_at,
           p.is_active, t.chat_id as t_chat, t.status as t_status
    from public.reminder_deliveries d
    join public.follow_ups f on f.id = d.follow_up_id
    join public.leads l on l.id = f.lead_id
    join public.profiles p on p.id = d.recipient_id
    left join public.telegram_connections t on t.user_id = d.recipient_id
    where d.state in ('pending', 'processing') and d.next_attempt_at <= now()
    order by d.next_attempt_at, d.id
    limit p_limit
    for update of d skip locked
  loop
    v_reason := case
      when r.fu_state <> 'pending' then 'follow_up_' || r.fu_state::text
      when r.fu_revision <> r.revision then 'superseded'
      when r.archived_at is not null then 'lead_archived'
      when r.assignee_id <> r.recipient_id or r.owner_id <> r.recipient_id then 'recipient_changed'
      when not r.is_active then 'recipient_inactive'
      else null end;

    if v_reason is not null then
      update public.reminder_deliveries
        set state = case when v_reason in ('superseded', 'follow_up_completed', 'follow_up_cancelled')
                         then 'cancelled' else 'skipped' end::public.reminder_state,
            last_error = v_reason, lease_token = null
        where id = r.id;
      continue;
    end if;

    if r.attempts >= v_max_attempts then
      update public.reminder_deliveries
        set state = 'failed', last_error = coalesce(last_error, 'max_attempts_reached'), lease_token = null
        where id = r.id;
      continue;
    end if;

    if r.t_chat is null or r.t_status <> 'connected' then
      update public.reminder_deliveries
        set state = 'failed', lease_token = null,
            last_error = case when r.t_chat is null then 'telegram_not_connected' else 'telegram_blocked' end
        where id = r.id;
      continue;
    end if;

    v_token := gen_random_uuid();
    update public.reminder_deliveries
      set state = 'processing', attempts = attempts + 1, lease_token = v_token,
          next_attempt_at = now() + make_interval(secs => p_lease_seconds)
      where id = r.id;

    delivery_id := r.id;
    lease_token := v_token;
    chat_id := r.t_chat;
    lead_id := r.l_id;
    lead_name := r.l_name;
    lead_phone := r.l_phone;
    task := r.fu_task;
    due_at := r.fu_due;
    attempts := r.attempts + 1;
    return next;
  end loop;
end $$;

-- p_result: sent | retry | failed | blocked
create function public.finish_reminder(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_result text,
  p_error text default null,
  p_retry_after_seconds integer default null,
  p_message_id bigint default null
)
returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_max_attempts constant integer := 5;
  v_row public.reminder_deliveries%rowtype;
  v_state public.reminder_state;
  v_error text := left(nullif(btrim(coalesce(p_error, '')), ''), 300);
begin
  if p_result not in ('sent', 'retry', 'failed', 'blocked') then
    raise exception 'invalid_result' using errcode = '22023';
  end if;
  select * into v_row from public.reminder_deliveries d
    where d.id = p_delivery_id and d.lease_token = p_lease_token and d.state = 'processing'
    for update;
  if not found then
    return 'lease_lost';
  end if;

  if p_result = 'sent' then
    update public.reminder_deliveries set state = 'sent', sent_at = now(), last_error = null,
      lease_token = null, telegram_message_id = p_message_id
      where id = v_row.id;
    return 'sent';
  end if;

  if p_result = 'retry' and v_row.attempts < v_max_attempts then
    v_state := 'pending';
    update public.reminder_deliveries set state = v_state, lease_token = null, last_error = v_error,
      next_attempt_at = now() + make_interval(secs => least(greatest(
        coalesce(p_retry_after_seconds, 60 * power(2, v_row.attempts - 1)::integer), 30), 3600))
      where id = v_row.id;
    return 'pending';
  end if;

  update public.reminder_deliveries set state = 'failed', lease_token = null,
    last_error = coalesce(v_error, 'delivery_failed')
    where id = v_row.id;
  if p_result = 'blocked' then
    update public.telegram_connections set status = 'blocked', last_error = v_error
      where user_id = v_row.recipient_id;
  end if;
  return 'failed';
end $$;

-- Bounded retention for delivery records and link tokens.
create function private.cleanup_reminder_data(p_keep_days integer default 90)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.reminder_deliveries
    where state in ('sent', 'failed', 'skipped', 'cancelled')
      and updated_at < now() - make_interval(days => greatest(p_keep_days, 7));
  get diagnostics v_deleted = row_count;
  delete from public.telegram_link_tokens where expires_at < now() - interval '1 day';
  return v_deleted;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;

grant execute on function
  public.check_duplicate_phone(text, uuid),
  public.create_lead(text, text, text, text, uuid, text, public.lead_status, uuid, text, timestamptz, text, boolean),
  public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean),
  public.list_leads(text, public.lead_status[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer),
  public.correct_note(uuid, text),
  public.complete_follow_up(uuid, text, timestamptz, text),
  public.list_follow_ups(text, uuid, text, integer, integer),
  public.merge_niches(uuid, uuid),
  public.admin_update_user(uuid, text, public.app_role, boolean),
  public.admin_log_password_reset(uuid),
  public.admin_list_users(text, public.app_role, integer, integer),
  public.dashboard_admin(integer),
  public.dashboard_sales(integer),
  public.dashboard_finance(integer),
  public.create_telegram_link_token(),
  public.disconnect_telegram()
to authenticated;

grant execute on function
  private.app_role(),
  private.is_admin(),
  private.is_lead_user(),
  private.is_finance_user(),
  private.can_access_lead(uuid),
  private.clean_label(text),
  private.escape_like(text),
  private.resolve_niche(uuid, text),
  private.raise_forbidden(),
  private.ist_today(),
  private.set_niche_merged(uuid, uuid)
to authenticated;

revoke execute on function
  public.consume_telegram_link_token(text, bigint, text),
  public.claim_due_reminders(integer, integer),
  public.finish_reminder(uuid, uuid, text, text, integer, bigint)
from authenticated;
grant execute on function
  public.consume_telegram_link_token(text, bigint, text),
  public.claim_due_reminders(integer, integer),
  public.finish_reminder(uuid, uuid, text, text, integer, bigint)
to service_role;
grant execute on function private.cleanup_reminder_data(integer) to service_role;
