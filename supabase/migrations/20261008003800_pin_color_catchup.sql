-- ---------------------------------------------------------------------------
-- Pin colour, again. The pin-colour half of 20261008002100_cad_note_pins was added to that file after it
-- had already been applied to the live database, so live got cad_x / cad_y but never pin_color and
-- "Pin note" failed there. Same statements, written to be a no-op where 2100 already added them.
-- ---------------------------------------------------------------------------

alter table public.project_file_comments
  add column if not exists pin_color text check (pin_color is null or pin_color in ('slate', 'blue', 'sky', 'violet', 'amber', 'orange', 'pink', 'emerald', 'red'));
grant insert (pin_color) on public.project_file_comments to authenticated;
grant update (pin_color) on public.project_file_comments to authenticated;

create or replace function private.project_file_comments_pin_color_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.pin_color is distinct from old.pin_color
     and not (old.author_id = (select auth.uid()) or private.can_manage_project(old.project_id)) then
    perform private.raise_forbidden();
  end if;
  return new;
end $$;

drop trigger if exists project_file_comments_pin_color_guard on public.project_file_comments;
create trigger project_file_comments_pin_color_guard before update of pin_color on public.project_file_comments
  for each row execute function private.project_file_comments_pin_color_guard();

notify pgrst, 'reload schema';
