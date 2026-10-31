-- ---------------------------------------------------------------------------
-- Call wrap-up: the call screen saves the call's result and note, the lead's status and its
-- temperature in one go (finish_call), all or nothing, and in that order in the timeline.
-- Admins may correct any call's talk time (set_call_duration), and an edit records who made it.
-- Additive: one new function; set_call_outcome (from 4500) and set_call_duration (from 4900)
-- re-created with the same signatures. Apply after 4900.
-- ---------------------------------------------------------------------------

-- Same as 4500 except: when the caller also picks a status (finish_call sets crm.call_stage_chosen),
-- a connected call doesn't move the lead from the first stage to Contacted on its own.
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

  if p_outcome = 'connected' and current_setting('crm.call_stage_chosen', true) is distinct from 'on' then
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

-- The call screen's Save. In order: the call's result and note, then the status (when picked and
-- different), then the temperature (when p_set_temperature; null clears it). The lead's own triggers
-- log the status and temperature changes; those rows get increasing times so the timeline (newest
-- first, ties broken by a random id) always reads call → status → temperature.
create or replace function public.finish_call(
  p_activity_id uuid,
  p_outcome text,
  p_note text default null,
  p_stage_id uuid default null,
  p_set_temperature boolean default false,
  p_temperature public.lead_temperature default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lead_id uuid;
  v_lead public.leads%rowtype;
begin
  select a.lead_id into v_lead_id from public.lead_activities a where a.id = p_activity_id and a.type = 'call_logged';
  -- Same rule as the leads_update policy: admin, or Sales on their own unarchived lead.
  if v_lead_id is null or not private.can_access_lead(v_lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_lead from public.leads l where l.id = v_lead_id for update;
  if p_stage_id is not null and p_stage_id is distinct from v_lead.stage_id and not exists (
    select 1 from public.pipeline_stages s where s.id = p_stage_id and s.company_id = v_lead.company_id and s.archived_at is null
  ) then
    raise exception 'invalid_stage' using errcode = '22023';
  end if;

  -- 1. The call (its own checks: the caller's call, within a day).
  perform set_config('crm.call_stage_chosen', case when p_stage_id is null then 'off' else 'on' end, true);
  perform public.set_call_outcome(p_activity_id, p_outcome, p_note);
  perform set_config('crm.call_stage_chosen', 'off', true);

  -- 2. Status.
  if p_stage_id is not null and p_stage_id is distinct from v_lead.stage_id then
    update public.leads set stage_id = p_stage_id where id = v_lead_id;
    update public.lead_activities a set created_at = clock_timestamp()
      where a.lead_id = v_lead_id and a.type = 'status_changed' and a.created_at = now() and a.actor_id is not distinct from v_uid;
  end if;

  -- 3. Temperature.
  if p_set_temperature and p_temperature is distinct from v_lead.temperature then
    update public.leads set temperature = p_temperature where id = v_lead_id;
    update public.lead_activities a set created_at = clock_timestamp()
      where a.lead_id = v_lead_id and a.type = 'lead_updated' and a.created_at = now() and a.actor_id is not distinct from v_uid;
  end if;
end $$;

revoke all on function public.finish_call(uuid, text, text, uuid, boolean, public.lead_temperature) from public, anon;
grant execute on function public.finish_call(uuid, text, text, uuid, boolean, public.lead_temperature) to authenticated;

-- Same as 4900, plus: an admin (or super admin) of the lead's company may set any call's talk time,
-- however old; Sales still only their own call within a day. A change by someone other than the
-- caller, or of a recorded time, is marked as an edit with who made it.
create or replace function public.set_call_duration(p_activity_id uuid, p_seconds integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_call public.lead_activities%rowtype;
  v_admin boolean := coalesce(private.app_role() = 'admin', false);
  v_changed boolean;
begin
  if p_seconds is null or p_seconds < 0 or p_seconds > 86400 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  select * into v_call from public.lead_activities a where a.id = p_activity_id and a.type = 'call_logged';
  if not found or not private.can_access_lead(v_call.lead_id) or (not v_admin and v_call.actor_id is distinct from v_uid) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not v_admin and v_call.created_at < now() - interval '24 hours' then
    raise exception 'call_outcome_closed' using errcode = '22023';
  end if;
  v_changed := (v_call.meta ? 'duration_seconds' and (v_call.meta ->> 'duration_seconds')::integer <> p_seconds)
    or (v_call.actor_id is distinct from v_uid and (v_call.meta ->> 'duration_seconds') is distinct from p_seconds::text);
  update public.lead_activities
  set meta = v_call.meta || jsonb_build_object('duration_seconds', p_seconds)
    || case when v_changed then jsonb_strip_nulls(jsonb_build_object(
         'duration_edited_at', now(),
         'duration_edited_by', private.display_name(v_uid),
         'duration_measured_seconds', coalesce(v_call.meta -> 'duration_measured_seconds', v_call.meta -> 'duration_seconds')))
       else '{}'::jsonb end
  where id = v_call.id;
end $$;

notify pgrst, 'reload schema';
