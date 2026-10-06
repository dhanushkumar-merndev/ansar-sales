-- Personal stars and pins for leads and follow-ups.
--
-- Each Admin/Sales user stars the leads and follow-ups they can access; starred items
-- form a personal "Starred" list. Up to 10 starred items per list may be pinned, and
-- pinned items sort first (most recently pinned on top). Pinning stars the item;
-- unstarring removes the pin. Stars are private to their owner.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.lead_stars (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, lead_id)
);

create index lead_stars_lead_idx on public.lead_stars (lead_id);
create index lead_stars_pinned_idx on public.lead_stars (user_id, pinned_at desc) where pinned_at is not null;

create table public.follow_up_stars (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  follow_up_id uuid not null references public.follow_ups (id) on delete cascade,
  pinned_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, follow_up_id)
);

create index follow_up_stars_follow_up_idx on public.follow_up_stars (follow_up_id);
create index follow_up_stars_pinned_idx on public.follow_up_stars (user_id, pinned_at desc) where pinned_at is not null;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
-- At most 10 pins per user per list. The advisory lock serializes a user's concurrent
-- pin requests so two of them cannot both pass the count.
create function private.enforce_pin_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if new.pinned_at is null or (tg_op = 'UPDATE' and old.pinned_at is not null) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext(tg_table_name || ':' || new.user_id::text));
  if tg_table_name = 'lead_stars' then
    select count(*) into v_count from public.lead_stars s
      where s.user_id = new.user_id and s.pinned_at is not null and s.lead_id <> new.lead_id;
  else
    select count(*) into v_count from public.follow_up_stars s
      where s.user_id = new.user_id and s.pinned_at is not null and s.follow_up_id <> new.follow_up_id;
  end if;
  if v_count >= 10 then
    raise exception 'pin_limit' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger lead_stars_pin_limit
  before insert or update of pinned_at on public.lead_stars
  for each row execute function private.enforce_pin_limit();
create trigger follow_up_stars_pin_limit
  before insert or update of pinned_at on public.follow_up_stars
  for each row execute function private.enforce_pin_limit();

-- When a lead is reassigned, Sales users who lost access drop their stars on it (and
-- its follow-ups). When it is archived, everyone's stars are dropped. Stale pins would
-- otherwise use up slots for items that no longer appear in the Starred list.
create function private.leads_cleanup_stars()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.archived_at is not null and old.archived_at is null then
    delete from public.lead_stars s where s.lead_id = new.id;
    delete from public.follow_up_stars s using public.follow_ups f
      where f.id = s.follow_up_id and f.lead_id = new.id;
  elsif new.owner_id is distinct from old.owner_id then
    delete from public.lead_stars s using public.profiles p
      where s.lead_id = new.id and p.id = s.user_id and p.role <> 'admin' and s.user_id <> new.owner_id;
    delete from public.follow_up_stars s using public.follow_ups f, public.profiles p
      where f.id = s.follow_up_id and f.lead_id = new.id
        and p.id = s.user_id and p.role <> 'admin' and s.user_id <> new.owner_id;
  end if;
  return null;
end $$;

create trigger leads_cleanup_stars
  after update of owner_id, archived_at on public.leads
  for each row execute function private.leads_cleanup_stars();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.lead_stars enable row level security;
alter table public.follow_up_stars enable row level security;

create policy lead_stars_select on public.lead_stars for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_lead_user()) and private.can_access_lead(lead_id));
create policy lead_stars_insert on public.lead_stars for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_lead_user()) and private.can_access_lead(lead_id));
create policy lead_stars_update on public.lead_stars for update to authenticated
  using (user_id = (select auth.uid()) and (select private.is_lead_user()) and private.can_access_lead(lead_id))
  with check (user_id = (select auth.uid()) and (select private.is_lead_user()) and private.can_access_lead(lead_id));
create policy lead_stars_delete on public.lead_stars for delete to authenticated
  using (user_id = (select auth.uid()));

create policy follow_up_stars_select on public.follow_up_stars for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_lead_user()) and exists (
    select 1 from public.follow_ups f where f.id = follow_up_id and private.can_access_lead(f.lead_id)));
create policy follow_up_stars_insert on public.follow_up_stars for insert to authenticated
  with check (user_id = (select auth.uid()) and (select private.is_lead_user()) and exists (
    select 1 from public.follow_ups f where f.id = follow_up_id and private.can_access_lead(f.lead_id)));
create policy follow_up_stars_update on public.follow_up_stars for update to authenticated
  using (user_id = (select auth.uid()) and (select private.is_lead_user()) and exists (
    select 1 from public.follow_ups f where f.id = follow_up_id and private.can_access_lead(f.lead_id)))
  with check (user_id = (select auth.uid()) and (select private.is_lead_user()) and exists (
    select 1 from public.follow_ups f where f.id = follow_up_id and private.can_access_lead(f.lead_id)));
create policy follow_up_stars_delete on public.follow_up_stars for delete to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.lead_stars, public.follow_up_stars from anon, authenticated;
grant select, delete on public.lead_stars, public.follow_up_stars to authenticated;
grant insert (lead_id, pinned_at) on public.lead_stars to authenticated;
grant update (pinned_at) on public.lead_stars to authenticated;
grant insert (follow_up_id, pinned_at) on public.follow_up_stars to authenticated;
grant update (pinned_at) on public.follow_up_stars to authenticated;

-- ---------------------------------------------------------------------------
-- Star / pin functions (security invoker: RLS decides what may be starred)
-- ---------------------------------------------------------------------------
create function public.set_lead_star(p_lead_id uuid, p_starred boolean)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.leads l where l.id = p_lead_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_starred then
    insert into public.lead_stars (lead_id) values (p_lead_id) on conflict do nothing;
  else
    delete from public.lead_stars s where s.lead_id = p_lead_id and s.user_id = (select auth.uid());
  end if;
  return coalesce(
    (select jsonb_build_object('starred', true, 'pinned_at', s.pinned_at) from public.lead_stars s
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid())),
    jsonb_build_object('starred', false, 'pinned_at', null));
end $$;

create function public.set_lead_pin(p_lead_id uuid, p_pinned boolean)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.leads l where l.id = p_lead_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_pinned then
    -- Pinning also stars; re-pinning keeps the original pin time.
    insert into public.lead_stars (lead_id, pinned_at) values (p_lead_id, now())
      on conflict (user_id, lead_id) do update
      set pinned_at = coalesce(public.lead_stars.pinned_at, excluded.pinned_at);
  else
    update public.lead_stars s set pinned_at = null
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid()) and s.pinned_at is not null;
  end if;
  return coalesce(
    (select jsonb_build_object('starred', true, 'pinned_at', s.pinned_at) from public.lead_stars s
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid())),
    jsonb_build_object('starred', false, 'pinned_at', null));
end $$;

create function public.set_follow_up_star(p_follow_up_id uuid, p_starred boolean)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if not private.is_lead_user() or not exists (
    select 1 from public.follow_ups f where f.id = p_follow_up_id and private.can_access_lead(f.lead_id)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.follow_ups f join public.leads l on l.id = f.lead_id
             where f.id = p_follow_up_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_starred then
    insert into public.follow_up_stars (follow_up_id) values (p_follow_up_id) on conflict do nothing;
  else
    delete from public.follow_up_stars s where s.follow_up_id = p_follow_up_id and s.user_id = (select auth.uid());
  end if;
  return coalesce(
    (select jsonb_build_object('starred', true, 'pinned_at', s.pinned_at) from public.follow_up_stars s
      where s.follow_up_id = p_follow_up_id and s.user_id = (select auth.uid())),
    jsonb_build_object('starred', false, 'pinned_at', null));
end $$;

create function public.set_follow_up_pin(p_follow_up_id uuid, p_pinned boolean)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
begin
  if not private.is_lead_user() or not exists (
    select 1 from public.follow_ups f where f.id = p_follow_up_id and private.can_access_lead(f.lead_id)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.follow_ups f join public.leads l on l.id = f.lead_id
             where f.id = p_follow_up_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_pinned then
    insert into public.follow_up_stars (follow_up_id, pinned_at) values (p_follow_up_id, now())
      on conflict (user_id, follow_up_id) do update
      set pinned_at = coalesce(public.follow_up_stars.pinned_at, excluded.pinned_at);
  else
    update public.follow_up_stars s set pinned_at = null
      where s.follow_up_id = p_follow_up_id and s.user_id = (select auth.uid()) and s.pinned_at is not null;
  end if;
  return coalesce(
    (select jsonb_build_object('starred', true, 'pinned_at', s.pinned_at) from public.follow_up_stars s
      where s.follow_up_id = p_follow_up_id and s.user_id = (select auth.uid())),
    jsonb_build_object('starred', false, 'pinned_at', null));
end $$;

-- ---------------------------------------------------------------------------
-- list_leads: adds per-item star/pin state and a Starred-only view
-- ---------------------------------------------------------------------------
drop function public.list_leads(text, public.lead_status[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer);

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
      and ($3::public.lead_status[] is null or l.status = any($3))
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
  p_starred_only := coalesce(p_starred_only, false);

  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  execute 'select count(*) from public.leads l ' || v_where
    into v_total
    using v_pattern, v_digits, p_statuses, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only;

  -- In the Starred view, pinned leads come first (most recently pinned on top).
  execute format($q$
    with page as (
      select l.*, nf.next_due, nf.overdue, st.pinned_at as star_pinned_at, st.lead_id is not null as is_starred,
        row_number() over (order by case when $12 then st.pinned_at end desc nulls last, %s %s nulls last, l.id %s) as rn
      from public.leads l
      left join lateral (
        select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
      left join public.lead_stars st on st.lead_id = l.id and st.user_id = (select auth.uid())
      %s
      order by case when $12 then st.pinned_at end desc nulls last, %s %s nulls last, l.id %s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'phone', p.phone, 'email', p.email, 'status', p.status,
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
    using v_pattern, v_digits, p_statuses, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

-- ---------------------------------------------------------------------------
-- list_follow_ups: adds the 'starred' view and per-item star/pin state
-- ---------------------------------------------------------------------------
-- p_view: overdue | today | upcoming | pending | completed | cancelled | starred
create or replace function public.list_follow_ups(
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

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.set_lead_star(uuid, boolean),
  public.set_lead_pin(uuid, boolean),
  public.set_follow_up_star(uuid, boolean),
  public.set_follow_up_pin(uuid, boolean),
  public.list_leads(text, public.lead_status[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean),
  private.enforce_pin_limit(),
  private.leads_cleanup_stars()
from public, anon;

grant execute on function
  public.set_lead_star(uuid, boolean),
  public.set_lead_pin(uuid, boolean),
  public.set_follow_up_star(uuid, boolean),
  public.set_follow_up_pin(uuid, boolean),
  public.list_leads(text, public.lead_status[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.lead_stars, public.follow_up_stars;
  end if;
end $$;
