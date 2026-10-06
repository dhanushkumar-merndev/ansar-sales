-- Ads clients: won leads handed to the ads team, their own Meta ad accounts, and their read-only
-- portal logins. A closed client stops syncing but keeps every stored insight.

-- ---------------------------------------------------------------------------
-- Won lead → ads client (companies with won_to_ads_client)
-- ---------------------------------------------------------------------------
create function private.lead_won_to_ads_client()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid;
  v_niche text;
begin
  if not exists (select 1 from public.companies c where c.id = new.company_id and c.won_to_ads_client and c.archived_at is null) then
    return null;
  end if;
  select n.name into v_niche from public.niches n where n.id = new.niche_id;
  -- Only contact details move over, never notes.
  insert into public.ads_clients (company_id, lead_id, name, phone, email, business, created_by)
  values (new.company_id, new.id, new.name, new.phone, new.email, v_niche,
    (select p.id from public.profiles p where p.id = (select auth.uid())))
  on conflict (lead_id) do nothing
  returning id into v_client;
  if v_client is null then
    return null;
  end if;
  insert into public.lead_activities (lead_id, actor_id, type, body)
  values (new.id, null, 'note', 'Handed over to the ads team as a new ads client.');
  perform private.enqueue_for_ads_team(new.company_id, 'ads_client_new', jsonb_strip_nulls(jsonb_build_object(
    'ads_client_id', v_client, 'client', new.name, 'business', v_niche, 'won_by', private.display_name(new.owner_id))),
    'ads_client_new:' || v_client, (select auth.uid()));
  return null;
end $$;

create trigger leads_won_to_ads_client_insert after insert on public.leads
  for each row when (new.status = 'won') execute function private.lead_won_to_ads_client();
create trigger leads_won_to_ads_client_update after update on public.leads
  for each row when (new.status = 'won' and old.status is distinct from 'won') execute function private.lead_won_to_ads_client();

-- Company admin (own company) or super admin.
create function public.set_won_to_ads_client(p_company_id uuid, p_enabled boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  update public.companies set won_to_ads_client = coalesce(p_enabled, false) where id = p_company_id;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- The client must belong to the caller's current company (admin / ads manager), or any for the
-- super admin. Returns the client's company.
create function private.require_ads_client(p_client uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid;
begin
  select c.company_id into v_company from public.ads_clients c where c.id = p_client;
  if v_company is null or not (private.is_super_admin() or (private.is_ads_user() and v_company = private.current_company_id())) then
    perform private.raise_forbidden();
  end if;
  return v_company;
end $$;

create function private.ads_client_json(c public.ads_clients)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'company_id', c.company_id, 'lead_id', c.lead_id, 'name', c.name, 'phone', c.phone,
    'email', c.email, 'business', c.business, 'status', c.status, 'notes', c.notes, 'started_at', c.started_at,
    'closed_at', c.closed_at, 'created_at', c.created_at)
$$;

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------
create function public.list_ads_clients(
  p_search text default null, p_status text default null, p_limit integer default 20, p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
  v_today date := private.ist_today();
begin
  if not private.is_ads_user() then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if p_status is not null and p_status not in ('onboarding', 'active', 'paused', 'closed', 'open') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select c.* from public.ads_clients c
    where c.company_id = v_company
      and (p_status is null or (p_status = 'open' and c.status <> 'closed') or c.status = p_status)
      and (v_pattern is null or c.name ilike v_pattern or c.business ilike v_pattern or c.phone ilike v_pattern or c.email ilike v_pattern)
  ), page as (
    select f.*, row_number() over (order by (f.status = 'closed'), f.started_at desc, f.id desc) as rn
    from filtered f order by rn limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(private.ads_client_json(c) || jsonb_build_object(
      'account', (select private.ad_account_json(a, 'all') from public.ad_accounts a
        where a.ads_client_id = c.id order by a.archived_at nulls first, a.created_at desc limit 1),
      'last_30d', (select jsonb_build_object('spend', coalesce(sum(d.spend), 0), 'leads', coalesce(sum(d.leads), 0),
          'clicks', coalesce(sum(d.clicks), 0), 'impressions', coalesce(sum(d.impressions), 0))
        from public.ad_campaign_daily d join public.ad_accounts a on a.id = d.ad_account_id and a.ads_client_id = c.id
        where d.date > v_today - 30),
      'logins', (select count(*) from public.profiles p where p.ads_client_id = c.id and p.is_active)
    ) order by pg.rn), '[]'::jsonb)
    from page pg join public.ads_clients c on c.id = pg.id)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create function public.ads_client_detail(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_ads_client(p_id);
  return (
    select private.ads_client_json(c) || jsonb_build_object(
      'company_name', (select k.name from public.companies k where k.id = c.company_id),
      'accounts', coalesce((select jsonb_agg(private.ad_account_json(a, 'all') order by a.archived_at nulls first, a.created_at desc)
        from public.ad_accounts a where a.ads_client_id = c.id), '[]'::jsonb),
      'logins', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
          'is_active', p.is_active, 'created_at', p.created_at) order by p.created_at)
        from public.profiles p where p.ads_client_id = c.id), '[]'::jsonb))
    from public.ads_clients c where c.id = p_id
  );
end $$;

-- Manually added client (not from a won lead).
create function public.create_ads_client(p_name text, p_phone text default null, p_email text default null,
  p_business text default null, p_notes text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_company uuid := private.current_company_id();
begin
  if not private.is_ads_user() or v_company is null then
    perform private.raise_forbidden();
  end if;
  if private.clean_label(p_name) is null then
    raise exception 'invalid_ads_client' using errcode = '22023';
  end if;
  insert into public.ads_clients (company_id, name, phone, email, business, notes, created_by)
  values (v_company, left(private.clean_label(p_name), 120), left(nullif(btrim(coalesce(p_phone, '')), ''), 32),
    left(nullif(lower(btrim(coalesce(p_email, ''))), ''), 254), left(private.clean_label(p_business), 120),
    left(nullif(btrim(coalesce(p_notes, '')), ''), 2000), (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

create function public.update_ads_client(p_id uuid, p_name text default null, p_phone text default null, p_email text default null,
  p_business text default null, p_notes text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_ads_client(p_id);
  update public.ads_clients set
    name = coalesce(left(private.clean_label(p_name), 120), name),
    phone = case when p_phone is null then phone else left(nullif(btrim(p_phone), ''), 32) end,
    email = case when p_email is null then email else left(nullif(lower(btrim(p_email)), ''), 254) end,
    business = case when p_business is null then business else left(private.clean_label(p_business), 120) end,
    notes = case when p_notes is null then notes else left(nullif(btrim(p_notes), ''), 2000) end
  where id = p_id;
end $$;

-- Closing stops syncing (history stays) and by default disables the client's logins.
-- Reopening resumes syncing; the next sync back-fills the gap.
create function public.set_ads_client_status(p_id uuid, p_status text, p_disable_logins boolean default true)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.ads_clients%rowtype;
begin
  perform private.require_ads_client(p_id);
  if p_status not in ('onboarding', 'active', 'paused', 'closed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into v_old from public.ads_clients c where c.id = p_id for update;
  update public.ads_clients set status = p_status,
    closed_at = case when p_status = 'closed' then coalesce(closed_at, now()) else null end
  where id = p_id;
  update public.ad_accounts set sync_paused = (p_status = 'closed'), next_sync_after = null where ads_client_id = p_id;
  if p_status = 'closed' and coalesce(p_disable_logins, true) then
    update public.profiles set is_active = false where ads_client_id = p_id and role = 'client' and is_active;
  end if;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_status', jsonb_build_object('ads_client_id', p_id, 'from', v_old.status, 'to', p_status));
end $$;

-- ---------------------------------------------------------------------------
-- Client portal logins
-- ---------------------------------------------------------------------------
-- Authorization check before the server creates a client login with the Auth Admin API.
create function public.ads_client_login_check(p_client uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.require_ads_client(p_client);
begin
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'client_login_create', jsonb_build_object('ads_client_id', p_client));
  return v_company;
end $$;

-- Enable/disable a client login, or authorize (and log) a password reset for it.
create function public.set_client_login(p_user_id uuid, p_is_active boolean default null, p_password_reset boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid;
begin
  select p.ads_client_id into v_client from public.profiles p where p.id = p_user_id and p.role = 'client';
  if v_client is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_ads_client(v_client);
  if p_is_active is not null then
    update public.profiles set is_active = p_is_active where id = p_user_id;
  end if;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, case when p_password_reset then 'password_reset' else 'user_updated' end,
    jsonb_strip_nulls(jsonb_build_object('is_active', p_is_active, 'ads_client_id', v_client)));
end $$;

-- The signed-in client's portal: their business, the agency brand and their ad accounts.
create function public.my_portal()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_client uuid := private.my_ads_client_id();
begin
  if v_client is null then
    perform private.raise_forbidden();
  end if;
  return (
    select jsonb_build_object(
      'client', jsonb_build_object('id', c.id, 'name', c.name, 'business', c.business, 'status', c.status, 'started_at', c.started_at),
      'agency', (select jsonb_build_object('name', k.name, 'brand_highlight', k.brand_highlight, 'logo_path', k.logo_path)
        from public.companies k where k.id = c.company_id),
      'accounts', coalesce((select jsonb_agg(private.ad_account_json(a, 'client') order by a.archived_at nulls first, a.created_at desc)
        from public.ad_accounts a where a.ads_client_id = c.id), '[]'::jsonb))
    from public.ads_clients c where c.id = v_client
  );
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.lead_won_to_ads_client(),
  private.require_ads_client(uuid),
  private.ads_client_json(public.ads_clients),
  public.set_won_to_ads_client(uuid, boolean),
  public.list_ads_clients(text, text, integer, integer),
  public.ads_client_detail(uuid),
  public.create_ads_client(text, text, text, text, text),
  public.update_ads_client(uuid, text, text, text, text, text),
  public.set_ads_client_status(uuid, text, boolean),
  public.ads_client_login_check(uuid),
  public.set_client_login(uuid, boolean, boolean),
  public.my_portal()
from public, anon, authenticated;

grant execute on function
  public.set_won_to_ads_client(uuid, boolean),
  public.list_ads_clients(text, text, integer, integer),
  public.ads_client_detail(uuid),
  public.create_ads_client(text, text, text, text, text),
  public.update_ads_client(uuid, text, text, text, text, text),
  public.set_ads_client_status(uuid, text, boolean),
  public.ads_client_login_check(uuid),
  public.set_client_login(uuid, boolean, boolean),
  public.my_portal()
to authenticated;
