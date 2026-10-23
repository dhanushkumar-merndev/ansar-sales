-- ---------------------------------------------------------------------------
-- Talk time edits stay visible: the first (measured) time is kept, and a later change records
-- when it was edited, so the timeline can show "edited, was 31 s".
-- Same as 4800's set_call_duration otherwise. Additive only (create or replace, same signature).
-- ---------------------------------------------------------------------------

create or replace function public.set_call_duration(p_activity_id uuid, p_seconds integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_call public.lead_activities%rowtype;
  v_changed boolean;
begin
  if p_seconds is null or p_seconds < 0 or p_seconds > 86400 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  select * into v_call from public.lead_activities a where a.id = p_activity_id and a.type = 'call_logged';
  if not found or v_call.actor_id is distinct from (select auth.uid()) or not private.can_access_lead(v_call.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_call.created_at < now() - interval '24 hours' then
    raise exception 'call_outcome_closed' using errcode = '22023';
  end if;
  v_changed := v_call.meta ? 'duration_seconds' and (v_call.meta ->> 'duration_seconds')::integer <> p_seconds;
  update public.lead_activities
  set meta = v_call.meta || jsonb_build_object('duration_seconds', p_seconds)
    || case when v_changed then jsonb_build_object(
         'duration_edited_at', now(),
         'duration_measured_seconds', coalesce(v_call.meta -> 'duration_measured_seconds', v_call.meta -> 'duration_seconds'))
       else '{}'::jsonb end
  where id = v_call.id;
end $$;

notify pgrst, 'reload schema';
