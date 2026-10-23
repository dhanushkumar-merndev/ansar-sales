-- ---------------------------------------------------------------------------
-- Notes beside the call screen, in an order the team picks, and New → Contacted on a connected call.
--
-- * lead_note_orders: one row per lead holding the dragged order of its notes and call notes.
--   Notes not in the saved order (newer ones) come first, newest on top.
-- * list_lead_notes / set_lead_note_order: read (RLS-scoped) and save that order.
-- * set_call_outcome: unchanged, except a "Connected" call moves a lead still in the company's
--   first stage (New) to its "Contacted" stage. The usual stage-change entry is logged.
-- Additive only: nothing is dropped, deleted or rewritten.
-- ---------------------------------------------------------------------------

create table public.lead_note_orders (
  lead_id uuid primary key references public.leads (id),
  activity_ids uuid[] not null default '{}',
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

alter table public.lead_note_orders enable row level security;

create policy lead_note_orders_select on public.lead_note_orders for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

grant select on public.lead_note_orders to authenticated;

-- A lead's notes and call notes in the saved order (RLS limits it to leads the caller can see).
create function public.list_lead_notes(p_lead_id uuid, p_limit integer default 50)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'type', x.type, 'body', x.body, 'meta', x.meta,
    'created_at', x.created_at, 'edited_at', x.edited_at,
    'actor', case when x.display_name is null then null else jsonb_build_object('display_name', x.display_name) end
  ) order by x.pos nulls first, x.created_at desc, x.id desc), '[]'::jsonb)
  from (
    select a.id, a.type, a.body, a.meta, a.created_at, a.edited_at, p.display_name,
      array_position(o.activity_ids, a.id) as pos
    from public.lead_activities a
    left join public.lead_note_orders o on o.lead_id = a.lead_id
    left join public.profiles p on p.id = a.actor_id
    where a.lead_id = p_lead_id
      and (a.type = 'note' or (a.type = 'call_logged' and a.body is not null))
    order by array_position(o.activity_ids, a.id) nulls first, a.created_at desc, a.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) x
$$;

create function public.set_lead_note_order(p_lead_id uuid, p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.leads l where l.id = p_lead_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_ids is null or cardinality(p_ids) > 200 then
    raise exception 'invalid_order' using errcode = '22023';
  end if;
  -- Keep only this lead's notes and call notes, in the given order, once each.
  select coalesce(array_agg(u.id order by u.ord), '{}') into v_ids
  from (
    select distinct on (i.id) i.id, i.ord
    from unnest(p_ids) with ordinality as i (id, ord)
    join public.lead_activities a on a.id = i.id and a.lead_id = p_lead_id and a.type in ('note', 'call_logged')
    order by i.id, i.ord
  ) u;
  insert into public.lead_note_orders (lead_id, activity_ids, updated_by, updated_at)
  values (p_lead_id, v_ids, (select auth.uid()), now())
  on conflict (lead_id) do update
    set activity_ids = excluded.activity_ids, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;

-- Same as 20261006001100, plus: a connected call moves a lead out of the first stage to "Contacted".
create or replace function public.set_call_outcome(p_activity_id uuid, p_outcome text, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_call public.lead_activities%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_lead public.leads%rowtype;
  v_first uuid;
  v_contacted uuid;
begin
  if p_outcome is null or p_outcome not in ('connected', 'no_answer', 'busy', 'wrong_number') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  if char_length(coalesce(v_note, '')) > 1000 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  select * into v_call from public.lead_activities a where a.id = p_activity_id and a.type = 'call_logged';
  if not found or v_call.actor_id is distinct from (select auth.uid()) or not private.can_access_lead(v_call.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_call.created_at < now() - interval '24 hours' then
    raise exception 'call_outcome_closed' using errcode = '22023';
  end if;
  update public.lead_activities
  set meta = v_call.meta || jsonb_build_object('outcome', p_outcome),
      body = v_note,
      edited_at = case when v_call.meta ? 'outcome' then now() else null end
  where id = v_call.id;

  if p_outcome = 'connected' then
    select * into v_lead from public.leads l where l.id = v_call.lead_id;
    if v_lead.archived_at is null then
      select s.id into v_first from public.pipeline_stages s
        where s.company_id = v_lead.company_id and s.archived_at is null and s.kind = 'open'
        order by s.position, s.id limit 1;
      select s.id into v_contacted from public.pipeline_stages s
        where s.company_id = v_lead.company_id and s.archived_at is null and s.kind = 'open' and lower(s.name) = 'contacted'
        limit 1;
      if v_lead.stage_id = v_first and v_contacted is not null and v_contacted <> v_first then
        update public.leads set stage_id = v_contacted where id = v_lead.id;
      end if;
    end if;
  end if;
end $$;

revoke all on function public.list_lead_notes(uuid, integer), public.set_lead_note_order(uuid, uuid[]) from public, anon;
grant execute on function public.list_lead_notes(uuid, integer), public.set_lead_note_order(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
