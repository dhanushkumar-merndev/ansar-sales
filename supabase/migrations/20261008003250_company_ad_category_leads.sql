-- ---------------------------------------------------------------------------
-- Shared ad accounts: map each merged company to one category of the owner's ad account, and send
-- the Facebook leads of that category's campaigns to the company's CRM. Leads that came in earlier
-- stay where they are.
--
-- * set_company_ad_category: the super admin picks the category (null: one named after the company,
--   as merging does). The company's previous category becomes an ordinary one, campaigns kept.
-- * ingest_meta_lead: a lead from a campaign in a merged company's category goes to that company.
-- * super_ads_overview: also lists the account's categories for the picker.
-- ---------------------------------------------------------------------------

create function public.set_company_ad_category(p_account uuid, p_company uuid, p_category uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
  v_current uuid;
  v_target uuid;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.ad_accounts a where a.id = p_account and a.kind = 'company' and a.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select k.name into v_name from public.ad_account_members m join public.companies k on k.id = m.company_id
  where m.ad_account_id = p_account and m.company_id = p_company;
  if v_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.ad_categories k where k.ad_account_id = p_account for update;
  select k.id into v_current from public.ad_categories k
  where k.ad_account_id = p_account and k.company_id = p_company and k.archived_at is null;

  if p_category is not null then
    select k.id into v_target from public.ad_categories k
    where k.id = p_category and k.ad_account_id = p_account and k.archived_at is null;
    if v_target is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.ad_categories k where k.id = v_target
               and (k.ads_client_id is not null or (k.company_id is not null and k.company_id <> p_company))) then
      raise exception 'category_in_use' using errcode = '23514';
    end if;
  else
    -- The default: the category named after the company.
    if exists (select 1 from public.ad_categories k where k.ad_account_id = p_account and k.archived_at is null
               and k.normalized_name = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'))
               and (k.ads_client_id is not null or (k.company_id is not null and k.company_id <> p_company))) then
      raise exception 'category_in_use' using errcode = '23514';
    end if;
    select k.id into v_target from public.ad_categories k where k.ad_account_id = p_account and k.archived_at is null
      and k.normalized_name = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g'));
  end if;
  if v_target is not distinct from v_current and v_target is not null then
    return;
  end if;

  update public.ad_categories set company_id = null where id = v_current;
  if v_target is null then
    insert into public.ad_categories (ad_account_id, name, company_id, match_text)
    values (p_account, left(v_name, 60), p_company, left(v_name, 60)) returning id into v_target;
  else
    update public.ad_categories set company_id = p_company where id = v_target;
  end if;
  perform private.auto_categorise_ads(p_account);
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ad_category_mapped', jsonb_build_object('ad_account_id', p_account, 'company_id', p_company,
    'category_id', v_target, 'previous_category_id', v_current));
end $$;

create or replace function public.super_ads_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', c.id, 'company_name', c.name, 'won_to_ads_client', c.won_to_ads_client,
      'account', (select private.ad_account_json(a, 'all') from public.ad_accounts a
        where a.company_id = c.id and a.kind = 'company' and a.archived_at is null),
      'members', coalesce((select jsonb_agg(m.company_id) from public.ad_account_members m
        join public.ad_accounts a on a.id = m.ad_account_id and a.company_id = c.id and a.kind = 'company' and a.archived_at is null), '[]'::jsonb),
      'member_of', (select a.company_id from public.ad_account_members m join public.ad_accounts a on a.id = m.ad_account_id
        where m.company_id = c.id and a.archived_at is null limit 1),
      -- The categories of the company's own live account, for mapping a merged company to one.
      'account_categories', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'company_id', k.company_id,
          'ads_client_id', k.ads_client_id, 'campaigns', (select count(*) from public.ad_campaigns x where x.category_id = k.id))
          order by lower(k.name))
        from public.ad_accounts a join public.ad_categories k on k.ad_account_id = a.id and k.archived_at is null
        where a.company_id = c.id and a.kind = 'company' and a.archived_at is null), '[]'::jsonb)
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c where c.archived_at is null and c.parent_company_id is null
  );
end $$;

-- As in 20261008002800, plus the merged-company routing (v_mapped) before the ads-client one.
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

revoke all on function public.set_company_ad_category(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_company_ad_category(uuid, uuid, uuid) to authenticated;
