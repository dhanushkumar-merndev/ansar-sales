-- ---------------------------------------------------------------------------
-- Importing leads from Excel, up to 500 at a time.
--
-- * lead_phones_in_crm: which of the file's phone numbers are already leads in this company, so the
--   import screen can flag them before anything is sent (numbers only, nothing about the leads).
-- * import_leads: creates each row with create_lead (same rules, RLS and timeline as adding one lead).
--   A bad row is reported and the rest still go in. Per-lead alerts are switched off for the batch;
--   notify_lead_import then sends one summary to each owner and to the company's admins.
-- ---------------------------------------------------------------------------

create or replace function private.notify_lead_activity()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads%rowtype;
  v_fu public.follow_ups%rowtype;
  v_base jsonb;
begin
  if new.type::text not in ('lead_created', 'status_changed', 'assigned', 'follow_up_scheduled', 'follow_up_rescheduled') then
    return null;
  end if;
  select * into v_lead from public.leads l where l.id = new.lead_id;
  if not found or v_lead.archived_at is not null then
    return null;
  end if;
  v_base := jsonb_build_object(
    'lead_id', v_lead.id, 'lead_name', v_lead.name, 'actor', private.display_name(new.actor_id),
    'owner', private.display_name(v_lead.owner_id),
    'niche', (select n.name from public.niches n where n.id = v_lead.niche_id));

  -- A bulk import sends one summary instead (private.notify_lead_import).
  if new.type = 'lead_created' and current_setting('crm.lead_import', true) = 'on' then
    return null;
  end if;

  if new.type = 'lead_created' then
    perform private.enqueue_for_company(v_lead.company_id, array['admin']::public.app_role[], 'lead_created',
      v_base || jsonb_build_object('status', v_lead.status), 'lead_created:' || v_lead.id, new.actor_id, v_lead.id);
    -- Created by someone else on the owner's behalf.
    perform private.enqueue_notification(v_lead.owner_id, 'lead_assigned',
      v_base || jsonb_build_object('phone', v_lead.phone), 'lead_assigned:' || new.id, new.actor_id, v_lead.id);
  elsif new.type = 'assigned' then
    perform private.enqueue_notification(v_lead.owner_id, 'lead_assigned',
      v_base || jsonb_build_object('phone', v_lead.phone, 'from', new.meta ->> 'from'), 'lead_assigned:' || new.id,
      new.actor_id, v_lead.id);
  elsif new.type = 'status_changed' then
    if coalesce(new.meta ->> 'to_kind', new.meta ->> 'to') in ('won', 'lost') then
      perform private.enqueue_for_company(v_lead.company_id, array['admin']::public.app_role[], 'lead_closed',
        v_base || jsonb_build_object('status', coalesce(new.meta ->> 'to_kind', new.meta ->> 'to'), 'stage', new.meta ->> 'to'), 'lead_closed:' || new.id, new.actor_id, v_lead.id);
    end if;
  else
    select * into v_fu from public.follow_ups f where f.id = new.follow_up_id;
    if found and v_fu.state = 'pending' then
      perform private.enqueue_notification(v_fu.assignee_id, 'follow_up_changed',
        v_base || jsonb_build_object('follow_up_id', v_fu.id, 'task', v_fu.task, 'due_at', v_fu.due_at,
          'rescheduled', new.type = 'follow_up_rescheduled'),
        'follow_up_changed:' || new.id, new.actor_id, v_lead.id, v_fu.id);
    end if;
  end if;
  return null;
end $$;

create function public.lead_phones_in_crm(p_phones text[])
returns text[]
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if cardinality(p_phones) > 500 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;
  return coalesce((
    select array_agg(distinct l.phone_normalized) from public.leads l
    where l.company_id = private.current_company_id() and l.archived_at is null
      and l.phone_normalized = any(coalesce(p_phones, '{}'))), '{}');
end $$;

-- One summary per owner ("12 leads imported to you") and one to the admins, for the leads the caller
-- created in this transaction. now() is the transaction's start, so nothing older is counted.
create function private.notify_lead_import()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_company uuid := private.current_company_id();
  v_total integer;
  v_by text := private.display_name(v_uid);
  r record;
begin
  select count(*) into v_total from public.leads l
  where l.created_by = v_uid and l.company_id = v_company and l.created_at = now();
  if v_total = 0 then
    return;
  end if;
  for r in
    select l.owner_id, count(*) as n from public.leads l
    where l.created_by = v_uid and l.company_id = v_company and l.created_at = now()
    group by l.owner_id
  loop
    perform private.enqueue_notification(r.owner_id, 'lead_assigned',
      jsonb_build_object('imported', r.n, 'actor', v_by), 'lead_import:' || txid_current() || ':' || r.owner_id, v_uid);
  end loop;
  perform private.enqueue_for_company(v_company, array['admin']::public.app_role[], 'lead_created',
    jsonb_build_object('imported', v_total, 'actor', v_by), 'lead_import:' || txid_current(), v_uid);
end $$;

-- p_rows: [{ name, phone, phone_normalized, email?, company_name?, niche_id? | new_niche?, stage_id?,
-- owner_id?, note? }]. Returns [{ index, id }] or [{ index, error }] in the rows' order.
create function public.import_leads(p_rows jsonb, p_allow_duplicates boolean default false)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_row jsonb;
  v_i integer := 0;
  v_id uuid;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;
  perform set_config('crm.lead_import', 'on', true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    begin
      v_id := public.create_lead(
        p_name => v_row ->> 'name',
        p_phone => v_row ->> 'phone',
        p_phone_normalized => v_row ->> 'phone_normalized',
        p_email => nullif(v_row ->> 'email', ''),
        p_niche_id => nullif(v_row ->> 'niche_id', '')::uuid,
        p_new_niche => nullif(v_row ->> 'new_niche', ''),
        p_stage_id => nullif(v_row ->> 'stage_id', '')::uuid,
        p_owner_id => nullif(v_row ->> 'owner_id', '')::uuid,
        p_note => nullif(v_row ->> 'note', ''),
        p_allow_duplicate => coalesce(p_allow_duplicates, false),
        p_company_name => nullif(v_row ->> 'company_name', ''));
      v_out := v_out || jsonb_build_array(jsonb_build_object('index', v_i, 'id', v_id));
    exception when others then
      -- Only our own error codes reach the screen; anything else is reported generically.
      v_out := v_out || jsonb_build_array(jsonb_build_object('index', v_i, 'error',
        case when sqlerrm ~ '^[a-z_]{3,40}$' then sqlerrm else 'invalid_row' end));
    end;
    v_i := v_i + 1;
  end loop;
  perform set_config('crm.lead_import', 'off', true);
  perform private.notify_lead_import();
  return v_out;
end $$;

revoke all on function public.lead_phones_in_crm(text[]), private.notify_lead_import(), public.import_leads(jsonb, boolean)
from public, anon, authenticated;
grant execute on function public.lead_phones_in_crm(text[]), public.import_leads(jsonb, boolean) to authenticated;
-- import_leads runs as the caller and calls it.
grant execute on function private.notify_lead_import() to authenticated;
