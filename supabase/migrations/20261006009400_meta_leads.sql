-- Facebook Lead Ads, per company.
--
-- * meta_integrations: one Meta app + Page per company. The app secret and the (non-expiring)
--   system-user token are stored in Supabase Vault; the table keeps only their Vault ids.
-- * meta_lead_routing: the sales users who receive the company's Facebook leads. One user gets
--   them all; several share them round-robin (the one waiting longest gets the next lead).
-- * meta_lead_events: one row per Meta leadgen id (idempotency) with its outcome, shown as an inbox.
-- The webhook and sync run on the server with the service role; super admins configure through RPCs.

create table public.meta_integrations (
  company_id uuid primary key references public.companies (id) on delete cascade,
  app_id text not null check (app_id ~ '^[0-9]{5,25}$'),
  page_id text not null check (page_id ~ '^[0-9]{5,25}$'),
  page_name text,
  app_secret_id uuid not null,
  access_token_id uuid not null,
  verify_token text not null default replace(gen_random_uuid()::text, '-', ''),
  status text not null default 'unverified' check (status in ('unverified', 'connected', 'error')),
  last_checked_at timestamptz,
  last_event_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger meta_integrations_touch before update on public.meta_integrations
  for each row execute function private.touch_updated_at();

create table public.meta_lead_routing (
  company_id uuid not null references public.companies (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  last_assigned_at timestamptz,
  primary key (company_id, user_id)
);

create table public.meta_lead_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  leadgen_id text not null unique check (char_length(leadgen_id) <= 40),
  form_id text,
  form_name text,
  ad_name text,
  campaign_name text,
  state text not null default 'received' check (state in ('received', 'created', 'duplicate', 'failed')),
  lead_id uuid references public.leads (id) on delete set null,
  attempts integer not null default 0,
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index meta_lead_events_company_idx on public.meta_lead_events (company_id, created_at desc);
create trigger meta_lead_events_touch before update on public.meta_lead_events
  for each row execute function private.touch_updated_at();

alter table public.meta_integrations enable row level security;
alter table public.meta_lead_routing enable row level security;
alter table public.meta_lead_events enable row level security;
revoke all on public.meta_integrations, public.meta_lead_routing, public.meta_lead_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Super admin configuration
-- ---------------------------------------------------------------------------
-- Creates or updates a company's connection. Secrets are write-only: null keeps the stored one.
create function public.save_meta_integration(
  p_company_id uuid, p_app_id text, p_page_id text, p_app_secret text default null, p_access_token text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.meta_integrations%rowtype;
  v_secret text := nullif(btrim(coalesce(p_app_secret, '')), '');
  v_token text := nullif(btrim(coalesce(p_access_token, '')), '');
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (v_secret is not null and char_length(v_secret) > 200) or (v_token is not null and char_length(v_token) > 1000) then
    raise exception 'invalid_meta_settings' using errcode = '22023';
  end if;
  select * into v_row from public.meta_integrations m where m.company_id = p_company_id for update;
  if not found then
    if v_secret is null or v_token is null then
      raise exception 'meta_secrets_required' using errcode = '22023';
    end if;
    insert into public.meta_integrations (company_id, app_id, page_id, app_secret_id, access_token_id)
    values (p_company_id, btrim(p_app_id), btrim(p_page_id),
      vault.create_secret(v_secret, 'meta_app_secret:' || p_company_id, 'Meta app secret'),
      vault.create_secret(v_token, 'meta_access_token:' || p_company_id, 'Meta system user token'));
  else
    if v_secret is not null then
      perform vault.update_secret(v_row.app_secret_id, v_secret);
    end if;
    if v_token is not null then
      perform vault.update_secret(v_row.access_token_id, v_token);
    end if;
    update public.meta_integrations set app_id = btrim(p_app_id), page_id = btrim(p_page_id), status = 'unverified', last_error = null
    where company_id = p_company_id;
  end if;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'meta_integration_saved', jsonb_build_object('company_id', p_company_id));
exception when check_violation then
  raise exception 'invalid_meta_settings' using errcode = '22023';
end $$;

create function public.delete_meta_integration(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.meta_integrations%rowtype;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  delete from public.meta_integrations where company_id = p_company_id returning * into v_row;
  if found then
    delete from vault.secrets where id in (v_row.app_secret_id, v_row.access_token_id);
  end if;
end $$;

-- The sales users (or admins) of the company who receive its Facebook leads.
create function public.set_meta_routing(p_company_id uuid, p_user_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) x where not exists (
    select 1 from public.profiles p where p.id = x and p.company_id = p_company_id and p.is_active and p.role in ('sales', 'admin'))) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  delete from public.meta_lead_routing r where r.company_id = p_company_id and not (r.user_id = any(coalesce(p_user_ids, '{}')));
  insert into public.meta_lead_routing (company_id, user_id)
  select p_company_id, x from unnest(coalesce(p_user_ids, '{}')) x
  on conflict do nothing;
end $$;

-- Every company's connection (never the secrets), routing and recent inbox counts.
create function public.super_meta_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', c.id, 'company_name', c.name,
      'integration', (select jsonb_build_object('app_id', m.app_id, 'page_id', m.page_id, 'page_name', m.page_name,
          'verify_token', m.verify_token, 'status', m.status, 'last_checked_at', m.last_checked_at,
          'last_event_at', m.last_event_at, 'last_error', m.last_error)
        from public.meta_integrations m where m.company_id = c.id),
      'routing', coalesce((select jsonb_agg(r.user_id) from public.meta_lead_routing r where r.company_id = c.id), '[]'::jsonb),
      'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role) order by p.role desc, lower(p.display_name))
        from public.profiles p where p.company_id = c.id and p.is_active and p.role in ('sales', 'admin')), '[]'::jsonb),
      'leads_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'created' and e.created_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'failed' and e.created_at > now() - interval '7 days')
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c where c.archived_at is null
  );
end $$;

create function public.super_meta_events(p_company_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'leadgen_id', e.leadgen_id, 'form_name', e.form_name, 'ad_name', e.ad_name,
      'state', e.state, 'error', e.error, 'lead_id', e.lead_id, 'lead_name', l.name, 'owner', private.display_name(l.owner_id),
      'created_at', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
    from (select * from public.meta_lead_events x where x.company_id = p_company_id
          order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 50), 1), 100)) e
    left join public.leads l on l.id = e.lead_id
  );
end $$;

-- ---------------------------------------------------------------------------
-- Server-side (service role only): webhook, sync and connection checks
-- ---------------------------------------------------------------------------
create function public.meta_integration_secrets(p_company_id uuid)
returns table (app_id text, page_id text, verify_token text, app_secret text, access_token text)
language sql stable security definer set search_path = ''
as $$
  select m.app_id, m.page_id, m.verify_token,
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.app_secret_id),
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.access_token_id)
  from public.meta_integrations m
  join public.companies c on c.id = m.company_id and c.archived_at is null
  where m.company_id = p_company_id
$$;

create function public.set_meta_status(p_company_id uuid, p_status text, p_page_name text default null, p_error text default null)
returns void
language sql security definer set search_path = ''
as $$
  update public.meta_integrations set status = p_status, page_name = coalesce(p_page_name, page_name),
    last_error = left(p_error, 500), last_checked_at = now()
  where company_id = p_company_id
$$;

-- Records a leadgen id once. Returns true when it still needs to be turned into a lead.
create function public.record_meta_leadgen(p_company_id uuid, p_leadgen_id text, p_form_id text default null)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_state text;
begin
  insert into public.meta_lead_events (company_id, leadgen_id, form_id)
  values (p_company_id, p_leadgen_id, p_form_id)
  on conflict (leadgen_id) do nothing;
  select e.state into v_state from public.meta_lead_events e where e.leadgen_id = p_leadgen_id and e.company_id = p_company_id;
  update public.meta_integrations set last_event_at = now() where company_id = p_company_id;
  return v_state in ('received', 'failed');
end $$;

create function public.fail_meta_lead(p_company_id uuid, p_leadgen_id text, p_error text)
returns void
language sql security definer set search_path = ''
as $$
  update public.meta_lead_events set state = 'failed', attempts = attempts + 1, error = left(p_error, 500)
  where leadgen_id = p_leadgen_id and company_id = p_company_id and state in ('received', 'failed')
$$;

-- Turns one Facebook lead into a CRM lead (or a note on the existing lead with that phone).
-- Idempotent per leadgen id. Owner: the routed user waiting longest, else the company's first admin.
create function public.ingest_meta_lead(
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

  -- Round-robin among routed, active users of the company (locked so parallel webhooks take turns).
  select r.user_id into v_owner
  from public.meta_lead_routing r
  join public.profiles p on p.id = r.user_id and p.is_active and p.company_id = p_company_id and p.role in ('sales', 'admin')
  where r.company_id = p_company_id
  order by r.last_assigned_at nulls first, r.user_id
  limit 1
  for update of r;
  if v_owner is not null then
    update public.meta_lead_routing set last_assigned_at = clock_timestamp() where company_id = p_company_id and user_id = v_owner;
  else
    select p.id into v_owner from public.profiles p
    where p.company_id = p_company_id and p.is_active and p.role = 'admin' order by p.created_at, p.id limit 1;
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

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.save_meta_integration(uuid, text, text, text, text),
  public.delete_meta_integration(uuid),
  public.set_meta_routing(uuid, uuid[]),
  public.super_meta_overview(),
  public.super_meta_events(uuid, integer),
  public.meta_integration_secrets(uuid),
  public.set_meta_status(uuid, text, text, text),
  public.record_meta_leadgen(uuid, text, text),
  public.fail_meta_lead(uuid, text, text),
  public.ingest_meta_lead(uuid, text, text, text, text, text, text, text, text, text, text)
from public, anon, authenticated;

grant execute on function
  public.save_meta_integration(uuid, text, text, text, text),
  public.delete_meta_integration(uuid),
  public.set_meta_routing(uuid, uuid[]),
  public.super_meta_overview(),
  public.super_meta_events(uuid, integer)
to authenticated;

grant execute on function
  public.meta_integration_secrets(uuid),
  public.set_meta_status(uuid, text, text, text),
  public.record_meta_leadgen(uuid, text, text),
  public.fail_meta_lead(uuid, text, text),
  public.ingest_meta_lead(uuid, text, text, text, text, text, text, text, text, text, text)
to service_role;
