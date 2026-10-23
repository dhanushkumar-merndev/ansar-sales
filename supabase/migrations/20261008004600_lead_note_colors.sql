-- ---------------------------------------------------------------------------
-- A colour per note card on the call screen, shared like the note order.
--
-- * lead_note_orders.note_colors: { "<activity id>": "<palette colour>" }.
-- * list_lead_notes: unchanged from 4500 except each item carries its colour.
-- * set_lead_note_color: sets (or clears, with null) one note's colour.
-- Additive only: nothing is dropped, deleted or rewritten.
-- ---------------------------------------------------------------------------

alter table public.lead_note_orders add column note_colors jsonb not null default '{}'::jsonb;

create or replace function public.list_lead_notes(p_lead_id uuid, p_limit integer default 50)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'type', x.type, 'body', x.body, 'meta', x.meta,
    'created_at', x.created_at, 'edited_at', x.edited_at, 'color', x.color,
    'actor', case when x.display_name is null then null else jsonb_build_object('display_name', x.display_name) end
  ) order by x.pos nulls first, x.created_at desc, x.id desc), '[]'::jsonb)
  from (
    select a.id, a.type, a.body, a.meta, a.created_at, a.edited_at, p.display_name,
      array_position(o.activity_ids, a.id) as pos,
      o.note_colors ->> a.id::text as color
    from public.lead_activities a
    left join public.lead_note_orders o on o.lead_id = a.lead_id
    left join public.profiles p on p.id = a.actor_id
    where a.lead_id = p_lead_id
      and (a.type = 'note' or (a.type = 'call_logged' and a.body is not null))
    order by array_position(o.activity_ids, a.id) nulls first, a.created_at desc, a.id desc
    limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ) x
$$;

create function public.set_lead_note_color(p_lead_id uuid, p_activity_id uuid, p_color text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_lead_user() or not private.can_access_lead(p_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.leads l where l.id = p_lead_id and l.archived_at is not null) then
    raise exception 'lead_archived' using errcode = '22023';
  end if;
  if p_color is not null and p_color not in ('slate', 'blue', 'sky', 'violet', 'amber', 'orange', 'pink', 'emerald', 'red') then
    raise exception 'invalid_color' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.lead_activities a
    where a.id = p_activity_id and a.lead_id = p_lead_id and a.type in ('note', 'call_logged')
  ) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.lead_note_orders (lead_id, note_colors, updated_by, updated_at)
  values (p_lead_id, case when p_color is null then '{}'::jsonb else jsonb_build_object(p_activity_id::text, p_color) end, (select auth.uid()), now())
  on conflict (lead_id) do update
    set note_colors = case when p_color is null then public.lead_note_orders.note_colors - p_activity_id::text
                           else public.lead_note_orders.note_colors || jsonb_build_object(p_activity_id::text, p_color) end,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;

revoke all on function public.set_lead_note_color(uuid, uuid, text) from public, anon;
grant execute on function public.set_lead_note_color(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
