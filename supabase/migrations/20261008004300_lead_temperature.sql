-- ---------------------------------------------------------------------------
-- Lead temperature: a quick Hot / Medium / Cold marker, separate from the pipeline stage.
-- Unset (null) until someone picks one. Changes are logged with the other lead edits, and the
-- lead list can filter on it (new p_temperature argument goes last).
-- ---------------------------------------------------------------------------

create type public.lead_temperature as enum ('hot', 'medium', 'cold');

alter table public.leads add column temperature public.lead_temperature;
create index leads_temperature_idx on public.leads (temperature) where archived_at is null and temperature is not null;

-- Lead writes run as the caller (RLS), so the column needs the same privilege as the others.
grant update (temperature) on public.leads to authenticated;

-- Unchanged except that a temperature change is logged with the other edits.
create or replace function private.leads_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_changes jsonb := '{}'::jsonb;
  v_from public.pipeline_stages%rowtype;
  v_to public.pipeline_stages%rowtype;
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, new.created_by, 'lead_created', jsonb_build_object(
      'status', (select s.name from public.pipeline_stages s where s.id = new.stage_id),
      'stage_id', new.stage_id,
      'owner', private.display_name(new.owner_id),
      'niche', (select n.name from public.niches n where n.id = new.niche_id)
    ));
    return null;
  end if;

  if new.stage_id is distinct from old.stage_id then
    select * into v_from from public.pipeline_stages s where s.id = old.stage_id;
    select * into v_to from public.pipeline_stages s where s.id = new.stage_id;
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'status_changed', jsonb_build_object(
      'from', v_from.name, 'to', v_to.name, 'from_kind', v_from.kind, 'to_kind', v_to.kind,
      'from_stage_id', v_from.id, 'to_stage_id', v_to.id));
  end if;

  if new.owner_id is distinct from old.owner_id then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'assigned', jsonb_build_object(
      'from', private.display_name(old.owner_id),
      'to', private.display_name(new.owner_id)
    ));
    -- Keep pending follow-ups (and therefore reminder recipients) with the current owner.
    update public.follow_ups f set assignee_id = new.owner_id
      where f.lead_id = new.id and f.state = 'pending' and f.assignee_id <> new.owner_id;
  end if;

  if new.name is distinct from old.name then
    v_changes := v_changes || jsonb_build_object('Name', jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.company_name is distinct from old.company_name then
    v_changes := v_changes || jsonb_build_object('Company', jsonb_build_object('from', old.company_name, 'to', new.company_name));
  end if;
  if new.phone is distinct from old.phone then
    v_changes := v_changes || jsonb_build_object('Phone', jsonb_build_object('from', old.phone, 'to', new.phone));
  end if;
  if new.email is distinct from old.email then
    v_changes := v_changes || jsonb_build_object('Email', jsonb_build_object('from', old.email, 'to', new.email));
  end if;
  if new.niche_id is distinct from old.niche_id then
    v_changes := v_changes || jsonb_build_object('Niche', jsonb_build_object(
      'from', (select n.name from public.niches n where n.id = old.niche_id),
      'to', (select n.name from public.niches n where n.id = new.niche_id)));
  end if;
  if new.temperature is distinct from old.temperature then
    v_changes := v_changes || jsonb_build_object('Temperature', jsonb_build_object(
      'from', initcap(old.temperature::text), 'to', initcap(new.temperature::text)));
  end if;
  if v_changes <> '{}'::jsonb then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'lead_updated', jsonb_build_object('changes', v_changes));
  end if;

  if new.archived_at is distinct from old.archived_at then
    insert into public.lead_activities (lead_id, actor_id, type)
    values (new.id, v_uid, case when new.archived_at is null then 'lead_restored' else 'lead_archived' end::public.lead_activity_type);
  end if;
  return null;
end $$;

drop function public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean);

-- Unchanged except: optional temperature filter, and each item carries its temperature.
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
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature;

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
      'id', p.id, 'name', p.name, 'company_name', p.company_name, 'phone', p.phone, 'email', p.email, 'status', p.status, 'stage_id', p.stage_id,
      'source', p.source, 'temperature', p.temperature,
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
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

revoke all on function
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature)
from public, anon;

grant execute on function
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature)
to authenticated;

notify pgrst, 'reload schema';
