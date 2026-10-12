-- ---------------------------------------------------------------------------
-- Project folders: move up / move down (right-click in the folder tree). Admins and the project's
-- architect manager only, standard folders included (the update policy leaves those alone, so this runs
-- as definer after its own check). The folder swaps places with the neighbour the caller can see: an
-- architect manager doesn't see Payment proofs, so it is stepped over rather than swapped with unseen.
-- Siblings are first numbered 1..n in their current order (position, then name — new folders all start
-- at 100), so the swap always moves exactly one place.
-- ---------------------------------------------------------------------------

create function public.move_project_folder(p_folder_id uuid, p_direction text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  f public.project_folders;
  v_money boolean;
  v_other uuid;
  v_pos integer;
begin
  if p_direction not in ('up', 'down') then
    raise exception 'invalid_direction' using errcode = '22023';
  end if;
  select * into f from public.project_folders where id = p_folder_id and archived_at is null;
  if f.id is null or not private.can_manage_project(f.project_id) then
    perform private.raise_forbidden();
  end if;
  v_money := private.can_see_project_money(f.project_id);
  if f.restricted and not v_money then
    perform private.raise_forbidden();
  end if;

  -- Lock the siblings and number them in the order the tree shows them.
  perform 1 from public.project_folders
  where project_id = f.project_id and parent_id is not distinct from f.parent_id and archived_at is null
  for update;
  with r as (
    select id, row_number() over (order by position, name, id) as n
    from public.project_folders
    where project_id = f.project_id and parent_id is not distinct from f.parent_id and archived_at is null
  )
  update public.project_folders d set position = r.n from r where r.id = d.id and d.position is distinct from r.n;
  select position into v_pos from public.project_folders where id = f.id;

  -- The nearest sibling the caller can see in that direction.
  select id into v_other from public.project_folders
  where project_id = f.project_id and parent_id is not distinct from f.parent_id and archived_at is null and id <> f.id
    and (v_money or not restricted)
    and case when p_direction = 'up' then position < v_pos else position > v_pos end
  order by case when p_direction = 'up' then -position else position end
  limit 1;
  if v_other is null then
    return; -- already first / last
  end if;

  update public.project_folders set position = (select position from public.project_folders where id = v_other) where id = f.id;
  update public.project_folders set position = v_pos where id = v_other;
end $$;

revoke all on function public.move_project_folder(uuid, text) from public, anon;
grant execute on function public.move_project_folder(uuid, text) to authenticated;
