-- Leads: star and pin become separate, New leads come first, admins can see another user's stars and pins.
--
-- * lead_stars.starred: a row can now be a pin without a star (starred = false). Existing rows stay starred.
--   Pin = on top of every list the lead matches. Star = in the Starred tab.
-- * set_lead_star / set_lead_pin (from 20261006001300): independent; the row goes once neither is on.
-- * private.lead_marks(user): a user's stars and pins; the caller's own, or (admins) any lead user of the company.
--   lead_stars RLS stays own-rows-only.
-- * list_leads (from 20261008004700) + p_starred_by (admin only):
--   - Starred tab: starred leads only; with p_starred_by, that user's starred or pinned leads.
--   - Default sort (created, newest first): leads in the first open stage ("New") first, then pinned, then the rest.
--     Other sorts keep pins first.
--   - starred / pinned_at in each row belong to the viewed user; pinned_count stays the caller's.

alter table public.lead_stars add column starred boolean not null default true;

grant insert (lead_id, pinned_at, starred) on public.lead_stars to authenticated;
grant update (pinned_at, starred) on public.lead_stars to authenticated;

create or replace function public.set_lead_star(p_lead_id uuid, p_starred boolean)
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
    insert into public.lead_stars (lead_id, starred) values (p_lead_id, true)
      on conflict (user_id, lead_id) do update set starred = true;
  else
    -- A pin stays when the star goes.
    update public.lead_stars s set starred = false
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid()) and s.pinned_at is not null;
    delete from public.lead_stars s
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid()) and s.pinned_at is null;
  end if;
  return coalesce(
    (select jsonb_build_object('starred', s.starred, 'pinned_at', s.pinned_at) from public.lead_stars s
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid())),
    jsonb_build_object('starred', false, 'pinned_at', null));
end $$;

create or replace function public.set_lead_pin(p_lead_id uuid, p_pinned boolean)
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
    -- Pinning no longer stars; re-pinning keeps the original pin time.
    insert into public.lead_stars (lead_id, pinned_at, starred) values (p_lead_id, now(), false)
      on conflict (user_id, lead_id) do update
      set pinned_at = coalesce(public.lead_stars.pinned_at, excluded.pinned_at);
  else
    update public.lead_stars s set pinned_at = null
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid()) and s.pinned_at is not null and s.starred;
    delete from public.lead_stars s
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid()) and not s.starred;
  end if;
  return coalesce(
    (select jsonb_build_object('starred', s.starred, 'pinned_at', s.pinned_at) from public.lead_stars s
      where s.lead_id = p_lead_id and s.user_id = (select auth.uid())),
    jsonb_build_object('starred', false, 'pinned_at', null));
end $$;

-- A user's stars and pins on the current company's leads. Anyone gets their own; an admin (or super admin)
-- may read those of a lead user of the company (the same people list_lead_staff offers). Read-only.
create function private.lead_marks(p_user uuid)
returns table (lead_id uuid, starred boolean, pinned_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or p_user is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_user <> v_uid and not (
    private.is_admin() and exists (select 1 from public.list_lead_staff() s where s.id = p_user)
  ) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return query
    select s.lead_id, s.starred, s.pinned_at
    from public.lead_stars s
    join public.leads l on l.id = s.lead_id and l.company_id = private.current_company_id()
    where s.user_id = p_user;
end $$;

revoke all on function private.lead_marks(uuid) from public, anon;
grant execute on function private.lead_marks(uuid) to authenticated;

drop function public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature);

create function public.list_leads(
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
  v_uid uuid := (select auth.uid());
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
  v_viewer uuid;
  v_other boolean;
  v_new_stage uuid;
  v_bucket text := '0';
  v_pin_key text := 'm.pinned_at';
  v_total bigint;
  v_items jsonb;
  v_pinned bigint;
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

  execute v_marks || 'select count(*) from public.leads l ' || v_where
    into v_total
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature,
          v_viewer, v_other;

  execute v_marks || format($q$
    , ids as (
      select l.id, m.pinned_at as star_pinned_at, coalesce(m.starred, false) as is_starred,
             %6$s as bucket, %7$s as pin_key, %1$s as sort_key
      from public.leads l
      %2$s
      left join marks m on m.lead_id = l.id
      %3$s
      order by 4, 5 desc nulls last, 6 %4$s nulls last, l.id %4$s
      limit $10 offset $11
    ),
    page as (
      select ids.*, row_number() over (order by ids.bucket, ids.pin_key desc nulls last, ids.sort_key %4$s nulls last, ids.id %4$s) as rn
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
  $q$, v_order, v_sort_join, v_where, v_dir, v_next_due, v_bucket, v_pin_key)
    into v_items
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature,
          v_viewer, v_other;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = v_uid and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

revoke all on function
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature, uuid)
from public, anon;
grant execute on function
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature, uuid)
to authenticated;
