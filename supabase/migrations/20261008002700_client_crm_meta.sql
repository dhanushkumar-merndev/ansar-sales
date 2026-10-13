-- ---------------------------------------------------------------------------
-- Client CRMs, part 2: the client's Facebook leads and their ad results inside the CRM.
--
-- * Our team (whoever may enter the client's CRM) connects the client's Facebook Page to it from
--   the client's page, and chooses who gets the leads: the client's staff or our own people.
-- * People working in a client's CRM can read that client's ad results (read-only, like the
--   client's portal login).
-- ---------------------------------------------------------------------------

-- The ads client whose results the caller may read: a client login's own client, or the client
-- whose CRM the caller is working in. Null for everyone else.
create or replace function private.my_ads_client_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select coalesce(
    (select p.ads_client_id from public.profiles p
     join public.ads_clients c on c.id = p.ads_client_id
     where p.id = (select auth.uid()) and p.is_active and p.role = 'client'),
    (select c.id from public.ads_clients c where c.workspace_company_id = private.current_company_id()))
$$;

-- As before, plus: our team manages the Facebook connection of a client's CRM they may enter
-- (from the agency or from inside the CRM, although the CRM itself has no ads of its own).
create or replace function private.can_manage_meta(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_super_admin()
    or (private.app_role() = 'admin' and p_company_id is not null and p_company_id = private.current_company_id()
        and not private.company_has('no_ads'))
    or coalesce(private.can_enter_workspace(p_company_id), false);
$$;

-- For server actions that read the connection's secrets with the service role.
create function public.meta_can_manage(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.can_manage_meta(p_company_id), false) $$;

-- Unchanged except that, in a client's CRM, our team can be given the leads too.
create or replace function public.set_meta_routing(p_company_id uuid, p_user_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) x where not exists (
    select 1 from public.profiles p where p.id = x and p.is_active and p.role <> 'super_admin'
      and ((p.company_id = p_company_id and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
        or private.workspace_staff(p.id, p_company_id)))) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  delete from public.meta_lead_routing r where r.company_id = p_company_id and not (r.user_id = any(coalesce(p_user_ids, '{}')));
  insert into public.meta_lead_routing (company_id, user_id)
  select p_company_id, x from unnest(coalesce(p_user_ids, '{}')) x
  on conflict do nothing;
end $$;

-- Unchanged except for who can be given a lead in a client's CRM, and who gets it when nobody is chosen.
create or replace function public.ingest_meta_lead(
  p_company_id uuid, p_leadgen_id text, p_name text, p_phone text, p_phone_normalized text,
  p_email text default null, p_form_id text default null, p_form_name text default null, p_ad_name text default null,
  p_campaign_name text default null, p_answers text default null
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_event public.meta_lead_events%rowtype;
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

  -- Same phone already in this company: keep one lead, note the new submission on it.
  select l.id into v_existing from public.leads l
  where l.company_id = p_company_id and l.phone_normalized = p_phone_normalized and l.archived_at is null
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
    and ((p.company_id = p_company_id and (p.role in ('sales', 'admin') or p.extra_roles && array['sales', 'admin']::public.app_role[]))
      or private.workspace_staff(p.id, p_company_id))
  where r.company_id = p_company_id
  order by r.last_assigned_at nulls first, r.user_id
  limit 1
  for update of r;
  if v_owner is not null then
    update public.meta_lead_routing set last_assigned_at = clock_timestamp() where company_id = p_company_id and user_id = v_owner;
  else
    select p.id into v_owner from public.profiles p
    where p.company_id = p_company_id and p.is_active and (p.role = 'admin' or 'admin' = any(p.extra_roles)) order by p.created_at, p.id limit 1;
  end if;
  -- A client's CRM with no admin of its own: whoever on our team created it, else one of our admins.
  if v_owner is null then
    select p.id into v_owner from public.companies w
    join public.profiles p on p.is_active and p.role <> 'super_admin' and private.workspace_staff(p.id, w.id)
    where w.id = p_company_id and w.parent_company_id is not null
    order by (p.id is not distinct from w.created_by) desc, (p.company_id is not distinct from w.parent_company_id) desc, p.created_at, p.id
    limit 1;
  end if;
  if v_owner is null then
    select p.id into v_owner from public.profiles p where p.role = 'super_admin' and p.is_active order by p.created_at, p.id limit 1;
  end if;

  insert into public.niches (company_id, name) values (p_company_id, v_niche_name)
  on conflict (company_id, normalized_name) do nothing;
  select coalesce(n.merged_into_id, n.id) into v_niche from public.niches n
  where n.company_id = p_company_id and n.normalized_name = lower(regexp_replace(v_niche_name, '\s+', ' ', 'g'));

  insert into public.leads (company_id, name, phone, phone_normalized, email, niche_id, owner_id, created_by, source, source_meta)
  values (p_company_id, left(coalesce(private.clean_label(p_name), 'Facebook lead'), 120), left(p_phone, 32), p_phone_normalized,
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
  return jsonb_build_object('state', 'created', 'lead_id', v_lead, 'owner_id', v_owner);
end $$;


-- The Facebook connection of a client's CRM, for the client's page (the shape of one
-- super_meta_overview row; null until the CRM exists).
create function public.ads_client_crm_meta(p_client uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws uuid;
begin
  perform private.require_ads_client(p_client);
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
      'leads_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'created' and e.created_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'failed' and e.created_at > now() - interval '7 days'))
    from public.companies c where c.id = v_ws
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function public.meta_can_manage(uuid), public.ads_client_crm_meta(uuid) from public, anon, authenticated;
grant execute on function public.meta_can_manage(uuid), public.ads_client_crm_meta(uuid) to authenticated;
