-- Facebook leads: the niche is the form's name without its form number, date or "copy"
-- ("FORM 2 - PROSPECTING CRM - JULY 22" -> "PROSPECTING CRM"), so new forms for the same product
-- share one niche. Existing Facebook niches are renamed the same way; two that end up with the
-- same name are merged (their leads move, the old one is archived, as merge_niches does).

create function private.form_niche_name(p_form_name text)
returns text
language plpgsql immutable set search_path = ''
as $$
declare
  v_months constant text := '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
  v_orig text := private.clean_label(replace(coalesce(p_form_name, ''), '_', ' '));
  v_name text := v_orig;
  v_prev text;
begin
  if v_name is null then
    return null;
  end if;
  -- "FORM -", "Form 2 -", "FORM 2.1 -", "Lead form 3:" at the start.
  v_name := regexp_replace(v_name, '^(lead\s+)?form\s*[0-9]*(\.[0-9]+)*\s*[-–—:|]+\s*', '', 'i');
  -- Trailing dates, times and "copy", in any order ("OCT 10-copy", "JULY 22", "13/10/2026, 14:22").
  loop
    v_prev := v_name;
    v_name := regexp_replace(v_name, '[\s,]*\m\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?$', '', 'i');
    v_name := regexp_replace(v_name, '[\s–—-]*\(?\mcopy(\s*\d+)?\)?$', '', 'i');
    -- "5th March 2026" before "March 2026", so the day goes too.
    v_name := regexp_replace(v_name, '[\s–—,|-]*\m\d{1,2}(st|nd|rd|th)?\s*' || v_months || '\.?(\s*,?\s*\d{2,4})?$', '', 'i');
    v_name := regexp_replace(v_name, '[\s–—,|-]*\m' || v_months || '\.?\s*\d{1,4}(st|nd|rd|th)?(\s*,?\s*\d{2,4})?$', '', 'i');
    v_name := regexp_replace(v_name, '[\s–—,|-]*\m(\d{1,4}[/-]\d{1,2}([/-]\d{2,4})?|\d{1,2}\.\d{1,2}\.\d{2,4})$', '', 'i');
    v_name := regexp_replace(v_name, '[\s:|,.–—-]+$', '');
    exit when v_name = v_prev;
  end loop;
  -- Nothing left (the name was only a number or a date): keep the form's name.
  return left(coalesce(private.clean_label(v_name), v_orig), 60);
end $$;

grant execute on function private.form_niche_name(text) to authenticated;

-- As in 20261008003250, with the niche name from form_niche_name.
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
  perform private.enqueue_notification(v_owner, 'lead_assigned', jsonb_build_object(
    'lead_id', v_lead, 'lead_name', p_name, 'phone', p_phone, 'niche', v_niche_name,
    'owner', private.display_name(v_owner), 'actor', 'Facebook Lead Ads'), 'lead_assigned:fb:' || v_lead, null, v_lead);

  update public.meta_lead_events set state = 'created', lead_id = v_lead, error = null where id = v_event.id;
  return jsonb_build_object('state', 'created', 'lead_id', v_lead, 'owner_id', v_owner, 'company_id', v_target);
end $$;

-- Renames the niches holding Facebook leads; returns how many changed. Run once below.
create function private.clean_form_niches()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_clean text;
  v_target public.niches%rowtype;
  v_count integer := 0;
begin
  for r in
    select n.id, n.company_id, n.name from public.niches n
    where n.archived_at is null and n.merged_into_id is null
      and exists (select 1 from public.leads l where l.niche_id = n.id and l.source = 'facebook')
    order by n.created_at, n.id
  loop
    v_clean := private.form_niche_name(r.name);
    continue when v_clean is null or v_clean = r.name;
    select * into v_target from public.niches n
    where n.company_id = r.company_id and n.id <> r.id
      and n.normalized_name = lower(regexp_replace(v_clean, '\s+', ' ', 'g'));
    v_count := v_count + 1;
    if v_target.id is null then
      update public.niches set name = v_clean where id = r.id;
      continue;
    end if;
    -- The clean name already exists: merge into it (or into what it was merged into).
    if v_target.merged_into_id is not null then
      select * into v_target from public.niches n where n.id = v_target.merged_into_id;
    end if;
    if v_target.archived_at is not null then
      update public.niches set archived_at = null where id = v_target.id;
    end if;
    update public.leads set niche_id = v_target.id where niche_id = r.id;
    update public.niches set archived_at = now(), merged_into_id = v_target.id where id = r.id;
    update public.niches set merged_into_id = v_target.id where merged_into_id = r.id;
  end loop;
  return v_count;
end $$;

revoke all on function private.clean_form_niches() from public, anon, authenticated;

select private.clean_form_niches();
