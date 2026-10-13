-- ---------------------------------------------------------------------------
-- Client CRMs, part 3: the client's Facebook leads arrive without connecting anything twice.
--
-- * Leads that reach OUR Facebook connection from a campaign we run for an ads client (the campaign's
--   category on our ad account is linked to the client) go to that client's CRM by themselves.
-- * When the client's lead forms are on their own Page, that Page is connected with our Meta app:
--   only the Page ID is typed (connect_client_page copies our app and token).
-- * Fix: ads_client_detail returned the agency's name as "company_name", hiding the client's own
--   company name. It is "agency_name" now.
-- ---------------------------------------------------------------------------

-- A new optional argument: drop the old signature so no ambiguous overload remains.
drop function public.ingest_meta_lead(uuid, text, text, text, text, text, text, text, text, text, text);

create function public.ingest_meta_lead(
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
  v_owner uuid;
  v_niche uuid;
  v_niche_name text := coalesce(left(private.clean_label(p_form_name), 60), 'Facebook Lead Ads');
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

  -- A campaign we run for an ads client (its category is linked to the client) whose CRM exists:
  -- the lead belongs in the client's CRM, not ours.
  select w.id into v_target
  from public.ad_campaigns c
  join public.ad_categories k on k.id = c.category_id and k.archived_at is null
  join public.ads_clients cl on cl.id = k.ads_client_id and cl.company_id = p_company_id
  join public.companies w on w.id = cl.workspace_company_id and w.archived_at is null
  where c.meta_id = nullif(btrim(coalesce(p_campaign_id, '')), '')
  limit 1;
  v_target := coalesce(v_target, p_company_id);

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

revoke all on function public.ingest_meta_lead(uuid, text, text, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.ingest_meta_lead(uuid, text, text, text, text, text, text, text, text, text, text, text) to service_role;

-- A company's inbox also shows the leads that landed in it from another connection (a client's CRM
-- gets them from ours), and ours says which CRM a lead went to.
create or replace function public.super_meta_events(p_company_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'leadgen_id', e.leadgen_id, 'form_name', e.form_name, 'ad_name', e.ad_name,
      'state', e.state, 'error', e.error, 'lead_id', e.lead_id, 'lead_name', l.name, 'owner', private.display_name(l.owner_id),
      'crm', case when l.company_id <> p_company_id then (select k.name from public.companies k where k.id = l.company_id) end,
      'created_at', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
    from (select * from public.meta_lead_events x
          where x.company_id = p_company_id
            or x.lead_id in (select y.id from public.leads y where y.company_id = p_company_id and y.source = 'facebook')
          order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 50), 1), 100)) e
    left join public.leads l on l.id = e.lead_id
  );
end $$;

create index meta_lead_events_lead_idx on public.meta_lead_events (lead_id) where lead_id is not null;

create or replace function public.ads_client_crm_meta(p_client uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_agency uuid := private.require_ads_client(p_client);
  v_ws uuid;
begin
  select c.workspace_company_id into v_ws from public.ads_clients c where c.id = p_client;
  if v_ws is null then
    return null;
  end if;
  if not private.can_manage_meta(v_ws) then
    perform private.raise_forbidden();
  end if;
  return (
    select jsonb_build_object(
      'company_id', c.id, 'company_name', c.name,
      'integration', (select jsonb_build_object('app_id', m.app_id, 'page_id', m.page_id, 'page_name', m.page_name,
          'verify_token', m.verify_token, 'status', m.status, 'last_checked_at', m.last_checked_at,
          'last_event_at', m.last_event_at, 'last_error', m.last_error)
        from public.meta_integrations m where m.company_id = c.id),
      'routing', coalesce((select jsonb_agg(r.user_id) from public.meta_lead_routing r where r.company_id = c.id), '[]'::jsonb),
      -- The client's own staff first, then our team.
      'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role,
          'ours', p.company_id is distinct from c.id)
          order by (p.company_id is distinct from c.id), p.role desc, lower(p.display_name))
        from public.profiles p
        where p.is_active and p.role <> 'super_admin'
          and ((p.company_id = c.id and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
            or private.workspace_staff(p.id, c.id))), '[]'::jsonb),
      -- Counted by where the lead is, so leads sent here from our own connection count too.
      'leads_7d', (select count(*) from public.meta_lead_events e join public.leads l on l.id = e.lead_id
        where l.company_id = c.id and e.state = 'created' and e.created_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'failed' and e.created_at > now() - interval '7 days'),
      -- Our own Facebook connection, and the categories on our ad account run for this client:
      -- leads from those campaigns come to this CRM by themselves.
      'agency', (select jsonb_build_object('app_id', m.app_id, 'page_id', m.page_id, 'page_name', m.page_name, 'status', m.status,
          'categories', coalesce((select jsonb_agg(k.name order by lower(k.name))
            from public.ad_categories k join public.ad_accounts a on a.id = k.ad_account_id and a.archived_at is null
            where k.ads_client_id = p_client and k.archived_at is null), '[]'::jsonb))
        from public.meta_integrations m where m.company_id = v_agency))
    from public.companies c where c.id = v_ws
  );
end $$;

-- Connects the client's own Facebook Page to their CRM with OUR Meta app and token, so only the
-- Page ID is typed. The Page must be assigned to our system user in Meta Business settings.
create function public.connect_client_page(p_client uuid, p_page_id text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_agency uuid := private.require_ads_client(p_client);
  v_ws uuid;
  v_app text;
  v_page text;
  v_secret text;
  v_token text;
begin
  select c.workspace_company_id into v_ws from public.ads_clients c where c.id = p_client;
  if v_ws is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select m.app_id, m.page_id,
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.app_secret_id),
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.access_token_id)
  into v_app, v_page, v_secret, v_token
  from public.meta_integrations m where m.company_id = v_agency;
  if not found then
    raise exception 'meta_secrets_required' using errcode = '22023';
  end if;
  -- Our own Page is already connected; its leads reach the client's CRM through the campaign's category.
  if btrim(coalesce(p_page_id, '')) = v_page then
    raise exception 'page_already_connected' using errcode = '22023';
  end if;
  -- Checks that the caller may manage the client's CRM connection, and stores the copies.
  perform public.save_meta_integration(v_ws, v_app, p_page_id, v_secret, v_token);
end $$;

-- The agency's name moves to "agency_name": "company_name" is the client's own company again.
create or replace function public.ads_client_detail(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.require_ads_client(p_id);
begin
  return (
    select private.ads_client_json(c) || jsonb_build_object(
      'agency_name', (select k.name from public.companies k where k.id = c.company_id),
      'accounts', coalesce((select jsonb_agg(private.ad_account_json(a, 'all') order by a.archived_at nulls first, a.created_at desc)
        from public.ad_accounts a where a.ads_client_id = c.id), '[]'::jsonb),
      -- The agency's live company ad account, with its categories for linking.
      'agency', (select jsonb_build_object('account', private.ad_account_json(a, 'all'),
          'categories', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'company_id', k.company_id,
              'ads_client_id', k.ads_client_id, 'client_name', (select x.name from public.ads_clients x where x.id = k.ads_client_id))
              order by lower(k.name))
            from public.ad_categories k where k.ad_account_id = a.id and k.archived_at is null), '[]'::jsonb))
        from public.ad_accounts a where a.company_id = v_company and a.kind = 'company' and a.archived_at is null),
      'agency_sources', coalesce((select jsonb_agg(jsonb_build_object('category_id', k.id, 'category_name', k.name, 'match_text', k.match_text,
          'campaigns', (select count(*) from public.ad_campaigns x where x.category_id = k.id),
          'account', private.ad_account_json(a, 'all')) order by a.archived_at nulls first, a.created_at desc)
        from public.ad_categories k join public.ad_accounts a on a.id = k.ad_account_id
        where k.ads_client_id = c.id and k.archived_at is null), '[]'::jsonb),
      'logins', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
          'is_active', p.is_active, 'created_at', p.created_at) order by p.created_at)
        from public.profiles p where p.ads_client_id = c.id), '[]'::jsonb))
    from public.ads_clients c where c.id = p_id
  );
end $$;

revoke all on function public.connect_client_page(uuid, text) from public, anon, authenticated;
grant execute on function public.connect_client_page(uuid, text) to authenticated;
