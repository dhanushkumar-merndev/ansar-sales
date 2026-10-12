-- ---------------------------------------------------------------------------
-- Note pins on DWG / DXF drawings. Pictures pin by percent of the picture (x_pct / y_pct); a drawing
-- zooms and pans, so its pins are kept in the drawing's own coordinates (cad_x / cad_y) and the viewer
-- places them wherever that point is on screen. A note has one kind of pin or none.
-- ---------------------------------------------------------------------------

alter table public.project_file_comments
  add column cad_x double precision,
  add column cad_y double precision,
  add constraint project_file_comments_cad_point check (
    (cad_x is null) = (cad_y is null)
    and (cad_x is null or (x_pct is null and y_pct is null and abs(cad_x) < 1e15 and abs(cad_y) < 1e15)));

grant insert (cad_x, cad_y) on public.project_file_comments to authenticated;

-- Pin colour (pictures and drawings): picked when pinning so the pin stands out from the drawing, e.g. a
-- sky pin on red site lines. The app's shared palette (STAGE_COLORS); none = the default (red, green for
-- the client). Whoever wrote the note, the architect manager or an admin can change it later.
alter table public.project_file_comments
  add column pin_color text check (pin_color is null or pin_color in ('slate', 'blue', 'sky', 'violet', 'amber', 'orange', 'pink', 'emerald', 'red'));
grant insert (pin_color) on public.project_file_comments to authenticated;
grant update (pin_color) on public.project_file_comments to authenticated;

create function private.project_file_comments_pin_color_guard()
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

create trigger project_file_comments_pin_color_guard before update of pin_color on public.project_file_comments
  for each row execute function private.project_file_comments_pin_color_guard();
