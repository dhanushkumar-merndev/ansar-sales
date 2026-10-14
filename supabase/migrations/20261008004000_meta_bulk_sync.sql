-- ---------------------------------------------------------------------------
-- Bulk Facebook sync: "Sync leads" saves up to 100 leads per database call instead of three calls
-- per lead, and tells each owner once ("N leads imported to you") instead of once per lead.
-- The webhook (one lead at a time, real time) is unchanged.
-- ---------------------------------------------------------------------------

-- As in 20261008003500, except that the owner's alert is skipped during a bulk sync.
create or replace function public.ingest_meta_lead(
  p_company_id uuid, p_leadgen_id text, p_name text, p_phone text, p_phone_normalized text,
  p_email text default null, p_form_id text default null, p_form_name text default null, p_ad_name text default null,
  p_campaign_name text default null, p_answers text default null, p_campaign_id text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event public.meta_lead_events%rowtype;
  -- The CRM the lead goes to: the company whose connection received it, or a client's CRM.
  v_target uuid := p_company_id;
  -- A merged company whose category on our ad account the campaign is in.
  v_mapped uuid;
  v_owner uuid;
  v_niche uuid;
  v_niche_name text := coalesce(private.form_niche_name(p_form_name), 'Facebook Lead Ads');
  v_existing uuid;
  v_lead uuid;
  v_source jsonb := jsonb_strip_nulls(jsonb_build_object('form_id', p_form_id, 'form_name', p_form_name, 'ad_name', p_ad_name,
    'campaign_name', p_campaign_name, 'leadgen_id', p_leadgen_id));
begin
  insert into public.meta_lead_events (company_id, leadgen_id, form_id)
  values (p_company_id, p_leadgen_id, p_form_id) on conflict (leadgen_id) do nothing;
  select * into v_event from public.meta_lead_events e where e.leadgen_id = p_leadgen_id and e.company_id = p_company_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_event.state in ('created', 'duplicate') then
    return jsonb_build_object('state', v_event.state, 'lead_id', v_event.lead_id);
  end if;
  update public.meta_lead_events set form_id = coalesce(p_form_id, form_id), form_name = p_form_name, ad_name = p_ad_name,
    campaign_name = p_campaign_name, attempts = attempts + 1
  where id = v_event.id;

  if p_phone_normalized is null or p_phone_normalized !~ '^\+[1-9][0-9]{6,14}$' then
    update public.meta_lead_events set state = 'failed', error = 'No valid phone number in the form answers.' where id = v_event.id;
    return jsonb_build_object('state', 'failed');
  end if;

  -- A campaign in the category of a company that shares this company's ad account: the lead
  -- belongs in that company's CRM.
  select k.company_id into v_mapped
  from public.ad_campaigns c
  join public.ad_accounts a on a.id = c.ad_account_id and a.company_id = p_company_id and a.kind = 'company'
  join public.ad_categories k on k.id = c.category_id and k.archived_at is null and k.company_id <> p_company_id
  join public.ad_account_members m on m.ad_account_id = a.id and m.company_id = k.company_id
  join public.companies t on t.id = k.company_id and t.archived_at is null
  where c.meta_id = nullif(btrim(coalesce(p_campaign_id, '')), '')
  limit 1;

  -- A campaign we run for an ads client (its category is linked to the client) whose CRM exists:
  -- the lead belongs in the client's CRM, not ours.
  select w.id into v_target
  from public.ad_campaigns c
  join public.ad_categories k on k.id = c.category_id and k.archived_at is null
  join public.ads_clients cl on cl.id = k.ads_client_id and cl.company_id = p_company_id
  join public.companies w on w.id = cl.workspace_company_id and w.archived_at is null
  where c.meta_id = nullif(btrim(coalesce(p_campaign_id, '')), '')
  limit 1;
  v_target := coalesce(v_mapped, v_target, p_company_id);

  -- Same phone already in this company: keep one lead, note the new submission on it.
  select l.id into v_existing from public.leads l
  where l.company_id = v_target and l.phone_normalized = p_phone_normalized and l.archived_at is null
  order by l.created_at limit 1;
  if v_existing is not null then
    insert into public.lead_activities (lead_id, actor_id, type, body)
    values (v_existing, null, 'note', left(concat_ws(E'\n', 'Submitted the Facebook form "' || coalesce(p_form_name, 'Lead form') || '" again.',
      nullif(btrim(coalesce(p_answers, '')), '')), 5000));
    update public.meta_lead_events set state = 'duplicate', lead_id = v_existing, error = null where id = v_event.id;
    return jsonb_build_object('state', 'duplicate', 'lead_id', v_existing);
  end if;

  -- Round-robin among routed, active users of the company, or of our team in a client's CRM
  -- (locked so parallel webhooks take turns).
  select r.user_id into v_owner
  from public.meta_lead_routing r
  join public.profiles p on p.id = r.user_id and p.is_active
    and ((p.company_id = v_target and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
      or private.workspace_staff(p.id, v_target))
  where r.company_id = v_target
  order by r.last_assigned_at nulls first, r.user_id
  limit 1
  for update of r;
  if v_owner is not null then
    update public.meta_lead_routing set last_assigned_at = clock_timestamp() where company_id = v_target and user_id = v_owner;
  else
    select p.id into v_owner from public.profiles p
    where p.company_id = v_target and p.is_active and (p.role = 'admin' or 'admin' = any(p.extra_roles)) order by p.created_at, p.id limit 1;
  end if;
  -- A client's CRM with no admin of its own: whoever on our team created it, else one of our admins.
  if v_owner is null then
    select p.id into v_owner from public.companies w
    join public.profiles p on p.is_active and p.role <> 'super_admin' and private.workspace_staff(p.id, w.id)
    where w.id = v_target and w.parent_company_id is not null
    order by (p.id is not distinct from w.created_by) desc, (p.company_id is not distinct from w.parent_company_id) desc, p.created_at, p.id
    limit 1;
  end if;
  if v_owner is null then
    select p.id into v_owner from public.profiles p where p.role = 'super_admin' and p.is_active order by p.created_at, p.id limit 1;
  end if;

  insert into public.niches (company_id, name) values (v_target, v_niche_name)
  on conflict (company_id, normalized_name) do nothing;
  select coalesce(n.merged_into_id, n.id) into v_niche from public.niches n
  where n.company_id = v_target and n.normalized_name = lower(regexp_replace(v_niche_name, '\s+', ' ', 'g'));

  insert into public.leads (company_id, name, phone, phone_normalized, email, niche_id, owner_id, created_by, source, source_meta)
  values (v_target, left(coalesce(private.clean_label(p_name), 'Facebook lead'), 120), left(p_phone, 32), p_phone_normalized,
    case when p_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(p_email) <= 254 then lower(btrim(p_email)) end,
    v_niche, v_owner, v_owner, 'facebook', v_source)
  returning id into v_lead;

  -- The timeline shows where the lead came from rather than the owner "creating" it.
  update public.lead_activities set actor_id = null, meta = meta || jsonb_build_object('source', 'facebook', 'form', p_form_name)
  where lead_id = v_lead and type = 'lead_created';
  if nullif(btrim(coalesce(p_answers, '')), '') is not null then
    insert into public.lead_activities (lead_id, actor_id, type, body)
    values (v_lead, null, 'note', left('Facebook form answers:' || E'\n' || p_answers, 5000));
  end if;
  -- The owner did not create it themselves, so tell them (the creation notice skips its "author").
  -- A bulk sync (ingest_meta_leads) sends one summary per person instead.
  if current_setting('crm.lead_import', true) is distinct from 'on' then
    perform private.enqueue_notification(v_owner, 'lead_assigned', jsonb_build_object(
      'lead_id', v_lead, 'lead_name', p_name, 'phone', p_phone, 'niche', v_niche_name,
      'owner', private.display_name(v_owner), 'actor', 'Facebook Lead Ads'), 'lead_assigned:fb:' || v_lead, null, v_lead);
  end if;

  update public.meta_lead_events set state = 'created', lead_id = v_lead, error = null where id = v_event.id;
  return jsonb_build_object('state', 'created', 'lead_id', v_lead, 'owner_id', v_owner, 'company_id', v_target);
end $$;

-- Up to 100 leads of one connection. Each row: leadgen_id, form_id, name, phone, phone_normalized,
-- email, form_name, ad_name, campaign_name, answers, campaign_id, adset_id, ad_id. Leads already
-- handled are skipped; one bad lead doesn't stop the rest. Returns one result per row.
create function public.ingest_meta_leads(p_company_id uuid, p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  r jsonb;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  perform set_config('crm.lead_import', 'on', true);
  for r in select value from jsonb_array_elements(p_rows) loop
    if not public.record_meta_leadgen(p_company_id, r ->> 'leadgen_id', nullif(r ->> 'form_id', '')) then
      v_out := v_out || jsonb_build_array(jsonb_build_object('leadgen_id', r ->> 'leadgen_id', 'state', 'skipped'));
      continue;
    end if;
    begin
      v_res := public.ingest_meta_lead(
        p_company_id => p_company_id, p_leadgen_id => r ->> 'leadgen_id',
        p_name => coalesce(nullif(r ->> 'name', ''), 'Facebook lead'), p_phone => coalesce(r ->> 'phone', ''),
        p_phone_normalized => nullif(r ->> 'phone_normalized', ''), p_email => nullif(r ->> 'email', ''),
        p_form_id => nullif(r ->> 'form_id', ''), p_form_name => nullif(r ->> 'form_name', ''),
        p_ad_name => nullif(r ->> 'ad_name', ''), p_campaign_name => nullif(r ->> 'campaign_name', ''),
        p_answers => nullif(r ->> 'answers', ''), p_campaign_id => nullif(r ->> 'campaign_id', ''));
      if coalesce(r ->> 'campaign_id', r ->> 'ad_id', '') <> '' then
        perform public.set_meta_lead_ad_ids(p_company_id, r ->> 'leadgen_id',
          coalesce(r ->> 'campaign_id', ''), coalesce(r ->> 'adset_id', ''), coalesce(r ->> 'ad_id', ''));
      end if;
      v_out := v_out || jsonb_build_array(jsonb_build_object('leadgen_id', r ->> 'leadgen_id', 'state', v_res ->> 'state',
        'company_id', v_res ->> 'company_id', 'owner_id', v_res ->> 'owner_id'));
    exception when others then
      perform public.fail_meta_lead(p_company_id, r ->> 'leadgen_id', sqlerrm);
      v_out := v_out || jsonb_build_array(jsonb_build_object('leadgen_id', r ->> 'leadgen_id', 'state', 'failed'));
    end;
  end loop;
  perform set_config('crm.lead_import', 'off', true);
  return v_out;
end $$;

-- After a bulk sync: one alert per owner. p_counts: {"<owner id>": number of new leads}.
create function public.notify_meta_leads_synced(p_counts jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
begin
  for r in select key::uuid as owner_id, value::text::integer as n from jsonb_each(coalesce(p_counts, '{}'::jsonb)) loop
    continue when r.n < 1;
    perform private.enqueue_notification(r.owner_id, 'lead_assigned',
      jsonb_build_object('imported', r.n, 'actor', 'Facebook Lead Ads'), 'lead_sync:' || r.owner_id || ':' || gen_random_uuid());
  end loop;
end $$;

-- Service role only (the sync runs on the server with the admin client).
revoke all on function public.ingest_meta_leads(uuid, jsonb), public.notify_meta_leads_synced(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_meta_leads(uuid, jsonb), public.notify_meta_leads_synced(jsonb) to service_role;
