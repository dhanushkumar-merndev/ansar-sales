-- ---------------------------------------------------------------------------
-- The project's original end date, so an extension shows ("Extended by 15 days, was 15 Nov").
-- Set once when the project is created and never changed; end_date is the current plan.
-- Existing projects take the end date they were created with (from their history).
-- Also: a phase's submitted date can't be before its actual start.
-- ---------------------------------------------------------------------------

alter table public.projects add column original_end_date date;
update public.projects p set original_end_date = coalesce(
  (select (a.meta ->> 'end')::date from public.project_activities a
   where a.project_id = p.id and a.type = 'project_created' and a.meta ? 'end' order by a.created_at limit 1),
  p.end_date);
alter table public.projects alter column original_end_date set not null;

create function private.projects_keep_original_end()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.original_end_date := case when tg_op = 'INSERT' then new.end_date else old.original_end_date end;
  return new;
end $$;

create trigger projects_keep_original_end before insert or update on public.projects
  for each row execute function private.projects_keep_original_end();

-- A phase can't be submitted before it started (the form and server actions check this too).
alter table public.project_phases add constraint project_phases_submitted_after_start
  check (submitted_on is null or actual_start is null or submitted_on >= actual_start);

create or replace function public.project_detail(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_p public.projects%rowtype;
  v_money boolean;
begin
  if not private.can_access_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_p from public.projects where id = p_project_id;
  v_money := private.can_see_project_money(p_project_id);
  return jsonb_build_object(
    'project', jsonb_build_object(
      'id', v_p.id, 'code', v_p.code, 'name', v_p.name, 'client_name', v_p.client_name, 'client_phone', v_p.client_phone,
      'client_email', v_p.client_email, 'site_address', v_p.site_address, 'site_lat', v_p.site_lat, 'site_lng', v_p.site_lng,
      'start_date', v_p.start_date, 'end_date', v_p.end_date, 'original_end_date', v_p.original_end_date,
      'completed_on', v_p.completed_on, 'status', v_p.status,
      'color', v_p.color, 'storage_quota_bytes', v_p.storage_quota_bytes, 'version', v_p.version,
      'created_at', v_p.created_at, 'updated_at', v_p.updated_at, 'archived_at', v_p.archived_at,
      'created_by', private.display_name(v_p.created_by)),
    'financials', case when v_money then (
      select jsonb_build_object('area_sqft', f.area_sqft, 'rate_per_sqft', f.rate_per_sqft, 'contract_value', f.contract_value)
      from public.project_financials f where f.project_id = p_project_id) end,
    'lead', (select jsonb_build_object('id', l.id, 'name', l.name, 'owner', private.display_name(l.owner_id), 'handoff_note', l.handoff_note)
      from public.leads l where l.id = v_p.lead_id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'display_name', pr.display_name, 'role', m.member_role,
        'added_at', m.added_at) order by m.member_role, pr.display_name)
      from public.project_members m join public.profiles pr on pr.id = m.user_id
      where m.project_id = p_project_id and m.removed_at is null and m.member_role <> 'client'), '[]'::jsonb),
    'phases', coalesce((select jsonb_agg(private.phase_json(ph) order by ph.position, ph.id)
      from public.project_phases ph where ph.project_id = p_project_id and ph.archived_at is null), '[]'::jsonb),
    'can', jsonb_build_object('manage', private.can_manage_project(p_project_id), 'money', v_money, 'admin', private.is_admin())
  );
end $$;

-- Every status change of the project's phases, oldest first (who and when), for the Gantt's status track:
-- in progress → in review → changes requested → done / skipped. Team and money roles alike (no money here).
create function public.project_phase_history(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_access_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('phase_id', a.phase_id, 'at', a.created_at, 'from', a.meta ->> 'from',
      'to', a.meta ->> 'to', 'by', private.display_name(a.actor_id)) order by a.created_at, a.id)
    from (select * from public.project_activities x
          where x.project_id = p_project_id and x.type = 'phase_status_changed' and x.phase_id is not null
          order by x.created_at desc limit 3000) a), '[]'::jsonb);
end $$;

revoke all on function public.project_phase_history(uuid) from public, anon;
grant execute on function public.project_phase_history(uuid) to authenticated;

-- Members submit, managers decide: a phase owner who doesn't manage the project may move their phase between
-- not started, in progress and in review (sent for review), but only the project's architect manager, an admin
-- or a super admin marks it done, skips it, asks for changes, or reopens a finished one.
create function private.project_phases_owner_status()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and new.status is distinct from old.status
     and (new.status in ('done', 'skipped', 'changes_requested') or old.status in ('done', 'skipped'))
     and not private.can_manage_project(old.project_id) then
    perform private.raise_forbidden();
  end if;
  return new;
end $$;

create trigger project_phases_owner_status before update on public.project_phases
  for each row execute function private.project_phases_owner_status();
