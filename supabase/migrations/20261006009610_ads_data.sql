-- Facebook Ads: ad accounts, campaigns, ads and daily insights, synced hourly from the Meta
-- Marketing API by the Next.js route /api/ads/sync (service role).
--
-- * ad_accounts: one per company (kind 'company') and one per ads client (kind 'client'). Each has
--   its own Meta app; the app secret and system-user token live in Supabase Vault.
-- * A company's ad account can be merged with other companies (ad_account_members, super admin).
--   Campaigns are split by ad_categories: a fixed category per merged company plus custom ones.
-- * Visibility (private.ad_access):
--     'all'     super admin, or admin / ads manager of the owning company
--     'company' admin / ads manager of a merged member company: only its category's campaigns
--     'client'  the ads client's own portal login: its own account, read-only
-- * Insights are kept permanently per campaign and day. Per-ad days are kept 90 days, then rolled
--   up into months (free-plan storage). Tables have RLS with no policies: everything goes through
--   the RPCs below, which check access explicitly.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.ad_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  kind text not null check (kind in ('company', 'client')),
  ads_client_id uuid references public.ads_clients (id),
  act_id text not null check (act_id ~ '^[0-9]{5,25}$'),
  name text check (name is null or char_length(name) <= 200),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  timezone text check (timezone is null or char_length(timezone) <= 64),
  app_id text not null check (app_id ~ '^[0-9]{5,25}$'),
  app_secret_id uuid,
  access_token_id uuid,
  status text not null default 'unverified' check (status in ('unverified', 'connected', 'error')),
  sync_paused boolean not null default false,
  last_checked_at timestamptz,
  last_synced_at timestamptz,
  synced_through date,
  backfilled_from date,
  next_sync_after timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint ad_accounts_client_check check ((kind = 'client') = (ads_client_id is not null))
);

-- One live connection per Meta ad account (no double counting), per company and per client.
create unique index ad_accounts_act_key on public.ad_accounts (act_id) where archived_at is null;
create unique index ad_accounts_company_key on public.ad_accounts (company_id) where kind = 'company' and archived_at is null;
create unique index ad_accounts_client_key on public.ad_accounts (ads_client_id) where archived_at is null;
create index ad_accounts_sync_idx on public.ad_accounts (last_synced_at nulls first) where archived_at is null and not sync_paused;
create trigger ad_accounts_touch before update on public.ad_accounts
  for each row execute function private.touch_updated_at();

create table public.ad_account_members (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (ad_account_id, company_id)
);
create index ad_account_members_company_idx on public.ad_account_members (company_id);

create table public.ad_categories (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60 and name = btrim(name)),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  -- Set for the fixed category of a merged company (cannot be renamed or archived).
  company_id uuid references public.companies (id),
  -- New campaigns whose name contains this text are categorised automatically.
  match_text text check (match_text is null or char_length(match_text) between 1 and 60),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index ad_categories_name_key on public.ad_categories (ad_account_id, normalized_name) where archived_at is null;
create unique index ad_categories_company_key on public.ad_categories (ad_account_id, company_id) where company_id is not null and archived_at is null;

create table public.ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  meta_id text not null check (char_length(meta_id) <= 40),
  name text not null check (char_length(name) <= 400),
  objective text,
  status text,
  effective_status text,
  daily_budget numeric(14, 2),
  lifetime_budget numeric(14, 2),
  created_time timestamptz,
  start_time timestamptz,
  stop_time timestamptz,
  category_id uuid references public.ad_categories (id) on delete set null,
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_campaigns_meta_key unique (ad_account_id, meta_id)
);
create index ad_campaigns_category_idx on public.ad_campaigns (ad_account_id, category_id);

create table public.ad_ads (
  id uuid primary key default gen_random_uuid(),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  meta_id text not null check (char_length(meta_id) <= 40),
  name text not null check (char_length(name) <= 400),
  status text,
  effective_status text,
  created_time timestamptz,
  updated_time timestamptz,
  -- Meta's signed image URLs expire; refreshed on every sync.
  thumbnail_url text check (thumbnail_url is null or char_length(thumbnail_url) <= 2000),
  preview_url text check (preview_url is null or char_length(preview_url) <= 2000),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ad_ads_meta_key unique (ad_account_id, meta_id)
);
create index ad_ads_campaign_idx on public.ad_ads (campaign_id, created_time desc);

create table public.ad_campaign_daily (
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  date date not null,
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  spend numeric(14, 2) not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  link_clicks bigint not null default 0,
  leads bigint not null default 0,
  conversions bigint not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  actions jsonb,
  updated_at timestamptz not null default now(),
  primary key (campaign_id, date)
);
create index ad_campaign_daily_account_idx on public.ad_campaign_daily (ad_account_id, date);

create table public.ad_ad_daily (
  ad_id uuid not null references public.ad_ads (id) on delete cascade,
  date date not null,
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  spend numeric(14, 2) not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  link_clicks bigint not null default 0,
  leads bigint not null default 0,
  conversions bigint not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  primary key (ad_id, date)
);
create index ad_ad_daily_campaign_idx on public.ad_ad_daily (campaign_id, date);

create table public.ad_ad_monthly (
  ad_id uuid not null references public.ad_ads (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  campaign_id uuid not null references public.ad_campaigns (id) on delete cascade,
  spend numeric(14, 2) not null default 0,
  impressions bigint not null default 0,
  reach bigint not null default 0,
  clicks bigint not null default 0,
  link_clicks bigint not null default 0,
  leads bigint not null default 0,
  conversions bigint not null default 0,
  conversion_value numeric(14, 2) not null default 0,
  primary key (ad_id, month)
);
create index ad_ad_monthly_campaign_idx on public.ad_ad_monthly (campaign_id, month);

-- Unique reach does not add up across days, so whole-month reach is stored separately.
create table public.ad_reach_monthly (
  ad_account_id uuid not null references public.ad_accounts (id) on delete cascade,
  campaign_id uuid references public.ad_campaigns (id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  reach bigint not null default 0,
  constraint ad_reach_monthly_key unique nulls not distinct (ad_account_id, campaign_id, month)
);

alter table public.ad_accounts enable row level security;
alter table public.ad_account_members enable row level security;
alter table public.ad_categories enable row level security;
alter table public.ad_campaigns enable row level security;
alter table public.ad_ads enable row level security;
alter table public.ad_campaign_daily enable row level security;
alter table public.ad_ad_daily enable row level security;
alter table public.ad_ad_monthly enable row level security;
alter table public.ad_reach_monthly enable row level security;
revoke all on public.ad_accounts, public.ad_account_members, public.ad_categories, public.ad_campaigns, public.ad_ads,
  public.ad_campaign_daily, public.ad_ad_daily, public.ad_ad_monthly, public.ad_reach_monthly from anon, authenticated;

-- Facebook leads remember which campaign and ad they came from (joined to spend in insights).
alter table public.meta_lead_events
  add column campaign_id text check (campaign_id is null or char_length(campaign_id) <= 40),
  add column adset_id text check (adset_id is null or char_length(adset_id) <= 40),
  add column ad_id text check (ad_id is null or char_length(ad_id) <= 40);
create index meta_lead_events_campaign_idx on public.meta_lead_events (company_id, campaign_id);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
create function private.ad_access(p_account uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when private.is_super_admin() then 'all'
    when private.is_ads_user() and a.company_id = private.current_company_id() then 'all'
    when private.is_ads_user() and a.kind = 'company' and exists (
      select 1 from public.ad_account_members m where m.ad_account_id = a.id and m.company_id = private.current_company_id()) then 'company'
    when a.kind = 'client' and a.ads_client_id = private.my_ads_client_id() then 'client'
  end
  from public.ad_accounts a where a.id = p_account
$$;

-- Raises forbidden unless the caller may see the account (and manage it, when p_manage).
create function private.require_ad_access(p_account uuid, p_manage boolean default false)
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v text := private.ad_access(p_account);
begin
  if v is null or (p_manage and v <> 'all') then
    perform private.raise_forbidden();
  end if;
  return v;
end $$;

-- The campaigns of an account the caller may see ('company' scope: its own category only).
create function private.visible_ad_campaigns(p_account uuid, p_scope text)
returns setof public.ad_campaigns
language sql stable security definer set search_path = ''
as $$
  select c.* from public.ad_campaigns c
  where c.ad_account_id = p_account
    and (p_scope <> 'company' or c.category_id in (
      select k.id from public.ad_categories k
      where k.ad_account_id = p_account and k.company_id = private.current_company_id() and k.archived_at is null))
$$;

create function private.check_ad_range(p_from date, p_to date)
returns void
language plpgsql immutable set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 1200 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
create function private.ad_account_json(a public.ad_accounts, p_scope text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id, 'kind', a.kind, 'company_id', a.company_id,
    'company_name', (select c.name from public.companies c where c.id = a.company_id),
    'ads_client_id', a.ads_client_id, 'act_id', a.act_id, 'name', a.name, 'currency', a.currency, 'timezone', a.timezone,
    'app_id', case when p_scope = 'all' then a.app_id end,
    'status', a.status, 'sync_paused', a.sync_paused, 'last_checked_at', a.last_checked_at, 'last_synced_at', a.last_synced_at,
    'synced_through', a.synced_through, 'backfilled_from', a.backfilled_from, 'last_error', case when p_scope = 'all' then a.last_error end,
    'archived_at', a.archived_at, 'created_at', a.created_at, 'scope', p_scope)
$$;

-- The company ad accounts visible in the caller's current company: its own (including disconnected
-- ones, for history) and those it was merged into.
create function public.ads_accounts_for_me()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if not private.is_ads_user() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(private.ad_account_json(a, private.ad_access(a.id))
      order by a.archived_at nulls first, (a.company_id = v_company) desc, a.created_at desc), '[]'::jsonb)
    from public.ad_accounts a
    where a.kind = 'company'
      and (a.company_id = v_company or exists (
        select 1 from public.ad_account_members m where m.ad_account_id = a.id and m.company_id = v_company))
      and private.ad_access(a.id) is not null
  );
end $$;

create function public.ad_account_detail(p_account uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope text := private.require_ad_access(p_account);
begin
  return (select private.ad_account_json(a, v_scope) from public.ad_accounts a where a.id = p_account);
end $$;

-- Creates or updates the ad account of a company (p_kind 'company', p_owner = company id) or of an
-- ads client (p_kind 'client', p_owner = client id). Secrets are write-only: null keeps the stored
-- ones. A different ad account id disconnects the old one (its history stays) and starts a new one.
-- p_use_lead_app copies the company's Facebook Lead Ads app and token.
create function public.save_ad_account(
  p_kind text, p_owner uuid, p_act_id text, p_app_id text default null,
  p_app_secret text default null, p_access_token text default null, p_use_lead_app boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid;
  v_client uuid;
  v_row public.ad_accounts%rowtype;
  v_id uuid;
  v_act text := regexp_replace(btrim(coalesce(p_act_id, '')), '^act_', '');
  v_app text := btrim(coalesce(p_app_id, ''));
  v_secret text := nullif(btrim(coalesce(p_app_secret, '')), '');
  v_token text := nullif(btrim(coalesce(p_access_token, '')), '');
  v_live boolean;
begin
  if p_kind = 'company' then
    select c.id into v_company from public.companies c where c.id = p_owner and c.archived_at is null;
  elsif p_kind = 'client' then
    select c.company_id, c.id into v_company, v_client from public.ads_clients c where c.id = p_owner;
  else
    raise exception 'invalid_ad_account' using errcode = '22023';
  end if;
  if v_company is null or not (private.is_super_admin() or (private.is_ads_user() and v_company = private.current_company_id())) then
    perform private.raise_forbidden();
  end if;

  if p_use_lead_app then
    if p_kind <> 'company' then
      raise exception 'invalid_ad_account' using errcode = '22023';
    end if;
    select m.app_id,
      (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.app_secret_id),
      (select s.decrypted_secret from vault.decrypted_secrets s where s.id = m.access_token_id)
    into v_app, v_secret, v_token
    from public.meta_integrations m where m.company_id = v_company;
    if not found then
      raise exception 'meta_secrets_required' using errcode = '22023';
    end if;
  end if;
  if v_act !~ '^[0-9]{5,25}$' or v_app !~ '^[0-9]{5,25}$'
     or char_length(coalesce(v_secret, '')) > 200 or char_length(coalesce(v_token, '')) > 1000 then
    raise exception 'invalid_ad_account' using errcode = '22023';
  end if;

  select * into v_row from public.ad_accounts a
  where a.archived_at is null and a.kind = p_kind
    and (case when p_kind = 'company' then a.company_id = v_company else a.ads_client_id = v_client end)
  for update;
  v_live := found;

  if v_live and v_row.act_id <> v_act then
    perform private.disconnect_ad_account_row(v_row.id);
    v_live := false;
  end if;

  if not v_live then
    -- Reconnecting an earlier account of the same owner keeps its history.
    select * into v_row from public.ad_accounts a
    where a.archived_at is not null and a.kind = p_kind and a.act_id = v_act
      and (case when p_kind = 'company' then a.company_id = v_company else a.ads_client_id = v_client end)
    order by a.archived_at desc limit 1
    for update;
    if v_secret is null or v_token is null then
      raise exception 'meta_secrets_required' using errcode = '22023';
    end if;
    if found then
      v_id := v_row.id;
      update public.ad_accounts set archived_at = null, app_id = v_app, status = 'unverified', last_error = null,
        app_secret_id = vault.create_secret(v_secret, 'ad_app_secret:' || v_id || ':' || extract(epoch from now())::bigint, 'Meta app secret (ads)'),
        access_token_id = vault.create_secret(v_token, 'ad_access_token:' || v_id || ':' || extract(epoch from now())::bigint, 'Meta system user token (ads)')
      where id = v_id;
    else
      v_id := gen_random_uuid();
      insert into public.ad_accounts (id, company_id, kind, ads_client_id, act_id, app_id, app_secret_id, access_token_id, created_by)
      values (v_id, v_company, p_kind, v_client, v_act, v_app,
        vault.create_secret(v_secret, 'ad_app_secret:' || v_id, 'Meta app secret (ads)'),
        vault.create_secret(v_token, 'ad_access_token:' || v_id, 'Meta system user token (ads)'),
        (select auth.uid()));
    end if;
  else
    v_id := v_row.id;
    if v_secret is not null then
      perform vault.update_secret(v_row.app_secret_id, v_secret);
    end if;
    if v_token is not null then
      perform vault.update_secret(v_row.access_token_id, v_token);
    end if;
    update public.ad_accounts set app_id = v_app, status = 'unverified', last_error = null, next_sync_after = null where id = v_id;
  end if;

  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ad_account_saved', jsonb_build_object('ad_account_id', v_id, 'company_id', v_company, 'kind', p_kind));
  return v_id;
exception when unique_violation then
  raise exception 'ad_account_taken' using errcode = '23505';
end $$;

create function private.disconnect_ad_account_row(p_account uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_secret uuid;
  v_token uuid;
begin
  select a.app_secret_id, a.access_token_id into v_secret, v_token
  from public.ad_accounts a where a.id = p_account and a.archived_at is null for update;
  if not found then
    return;
  end if;
  update public.ad_accounts set archived_at = now(), status = 'unverified', app_secret_id = null, access_token_id = null,
    next_sync_after = null
  where id = p_account;
  delete from vault.secrets where id in (v_secret, v_token);
end $$;

-- Stops syncing and deletes the stored secrets. All synced history stays.
create function public.disconnect_ad_account(p_account uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_ad_access(p_account, true);
  perform private.disconnect_ad_account_row(p_account);
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ad_account_disconnected', jsonb_build_object('ad_account_id', p_account));
end $$;

-- ---------------------------------------------------------------------------
-- Dashboards
-- ---------------------------------------------------------------------------
-- Totals, daily series, top campaigns and categories for a date range (ad account's own dates).
-- p_category filters to one category; p_uncategorised to campaigns without one.
create function public.ads_overview(
  p_account uuid, p_from date, p_to date, p_category uuid default null, p_uncategorised boolean default false
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope text := private.require_ad_access(p_account);
  v_result jsonb;
begin
  perform private.check_ad_range(p_from, p_to);
  with camps as (
    select c.* from private.visible_ad_campaigns(p_account, v_scope) c
    where (p_category is null or c.category_id = p_category)
      and (not coalesce(p_uncategorised, false) or c.category_id is null)
  ), d as (
    select d.* from public.ad_campaign_daily d join camps c on c.id = d.campaign_id
    where d.ad_account_id = p_account and d.date between p_from and p_to
  )
  select jsonb_build_object(
    'account', (select private.ad_account_json(a, v_scope) from public.ad_accounts a where a.id = p_account),
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
    'totals', (select jsonb_build_object(
        'spend', coalesce(sum(d.spend), 0), 'impressions', coalesce(sum(d.impressions), 0),
        'reach_daily_sum', coalesce(sum(d.reach), 0), 'clicks', coalesce(sum(d.clicks), 0),
        'link_clicks', coalesce(sum(d.link_clicks), 0), 'leads', coalesce(sum(d.leads), 0),
        'conversions', coalesce(sum(d.conversions), 0), 'conversion_value', coalesce(sum(d.conversion_value), 0),
        'campaigns', (select count(*) from camps),
        'active_campaigns', (select count(*) from camps where camps.effective_status = 'ACTIVE'))
      from d),
    -- Exact unique reach only for a single whole calendar month of the whole visible account.
    'reach_month', case
      when v_scope <> 'company' and p_category is null and not coalesce(p_uncategorised, false)
       and p_from = date_trunc('month', p_from)::date and p_to = (date_trunc('month', p_from) + interval '1 month - 1 day')::date
      then (select r.reach from public.ad_reach_monthly r where r.ad_account_id = p_account and r.campaign_id is null and r.month = p_from) end,
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('date', g.day::date, 'spend', coalesce(x.spend, 0), 'impressions', coalesce(x.impressions, 0),
        'clicks', coalesce(x.clicks, 0), 'leads', coalesce(x.leads, 0), 'conversions', coalesce(x.conversions, 0)) order by g.day), '[]'::jsonb)
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)
      left join (
        select d.date, sum(d.spend) as spend, sum(d.impressions) as impressions, sum(d.clicks) as clicks,
          sum(d.leads) as leads, sum(d.conversions) as conversions
        from d group by d.date
      ) x on x.date = g.day::date),
    'campaigns', (
      select coalesce(jsonb_agg(t order by (t ->> 'spend')::numeric desc, t ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object('id', c.id, 'name', c.name, 'spend', sum(d.spend), 'leads', sum(d.leads),
          'clicks', sum(d.clicks), 'impressions', sum(d.impressions), 'conversions', sum(d.conversions)) as t
        from d join camps c on c.id = d.campaign_id
        group by c.id, c.name
        having sum(d.spend) > 0 or sum(d.impressions) > 0
        order by sum(d.spend) desc, c.name
        limit 12
      ) s),
    'categories', case when v_scope <> 'company' then (
      select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', coalesce(k.name, 'Uncategorised'), 'company_id', k.company_id,
        'spend', x.spend, 'leads', x.leads) order by x.spend desc), '[]'::jsonb)
      from (
        select c.category_id, sum(d.spend) as spend, sum(d.leads) as leads
        from d join camps c on c.id = d.campaign_id group by c.category_id
      ) x left join public.ad_categories k on k.id = x.category_id) end
  ) into v_result;
  return v_result;
end $$;

-- One page of campaigns with their metrics for the range. Sort fields are allowlisted.
create function public.list_ad_campaigns(
  p_account uuid, p_from date, p_to date,
  p_category uuid default null, p_uncategorised boolean default false,
  p_search text default null, p_status text default null,
  p_sort text default 'spend', p_dir text default 'desc',
  p_limit integer default 20, p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope text := private.require_ad_access(p_account);
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  perform private.check_ad_range(p_from, p_to);
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if p_sort not in ('spend', 'name', 'created', 'leads', 'cpl', 'ctr', 'impressions', 'last_active') or p_dir not in ('asc', 'desc')
     or (p_status is not null and p_status not in ('active', 'inactive')) then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with camps as (
    select c.* from private.visible_ad_campaigns(p_account, v_scope) c
    where (p_category is null or c.category_id = p_category)
      and (not coalesce(p_uncategorised, false) or c.category_id is null)
      and (v_pattern is null or c.name ilike v_pattern)
      and (p_status is null or (p_status = 'active') = (c.effective_status = 'ACTIVE'))
  ), m as (
    select c.id, c.name, c.created_time,
      coalesce(sum(d.spend), 0) as spend, coalesce(sum(d.impressions), 0) as impressions, coalesce(sum(d.clicks), 0) as clicks,
      coalesce(sum(d.link_clicks), 0) as link_clicks, coalesce(sum(d.leads), 0) as leads, coalesce(sum(d.conversions), 0) as conversions,
      (select max(x.date) from public.ad_campaign_daily x where x.campaign_id = c.id and x.spend > 0) as last_active
    from camps c
    left join public.ad_campaign_daily d on d.campaign_id = c.id and d.date between p_from and p_to
    group by c.id, c.name, c.created_time
  ), ranked as (
    select m.*, row_number() over (order by
      case when p_dir = 'asc' then case p_sort
        when 'spend' then m.spend
        when 'leads' then m.leads
        when 'impressions' then m.impressions
        when 'cpl' then case when m.leads > 0 then m.spend / m.leads end
        when 'ctr' then case when m.impressions > 0 then m.clicks::numeric / m.impressions end end end asc nulls last,
      case when p_dir = 'desc' then case p_sort
        when 'spend' then m.spend
        when 'leads' then m.leads
        when 'impressions' then m.impressions
        when 'cpl' then case when m.leads > 0 then m.spend / m.leads end
        when 'ctr' then case when m.impressions > 0 then m.clicks::numeric / m.impressions end end end desc nulls last,
      case when p_sort = 'name' and p_dir = 'asc' then lower(m.name) end asc,
      case when p_sort = 'name' and p_dir = 'desc' then lower(m.name) end desc,
      case when p_sort = 'created' and p_dir = 'asc' then m.created_time end asc nulls last,
      case when p_sort = 'created' and p_dir = 'desc' then m.created_time end desc nulls last,
      case when p_sort = 'last_active' and p_dir = 'asc' then m.last_active end asc nulls last,
      case when p_sort = 'last_active' and p_dir = 'desc' then m.last_active end desc nulls last,
      m.spend desc, m.id) as rn
    from m
  ), page as (
    select * from ranked order by rn limit p_limit offset p_offset
  )
  select (select count(*) from camps),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'meta_id', c.meta_id, 'name', c.name, 'objective', c.objective, 'status', c.status, 'effective_status', c.effective_status,
      'daily_budget', c.daily_budget, 'lifetime_budget', c.lifetime_budget,
      'created_time', c.created_time, 'start_time', c.start_time, 'stop_time', c.stop_time,
      'category', case when k.id is not null then jsonb_build_object('id', k.id, 'name', k.name) end,
      'spend', pg.spend, 'impressions', pg.impressions, 'clicks', pg.clicks, 'link_clicks', pg.link_clicks,
      'leads', pg.leads, 'conversions', pg.conversions, 'last_active', pg.last_active,
      'ads', (select count(*) from public.ad_ads a where a.campaign_id = c.id)
    ) order by pg.rn), '[]'::jsonb)
    from page pg join public.ad_campaigns c on c.id = pg.id left join public.ad_categories k on k.id = c.category_id)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

-- A campaign's daily series and its ads (newest first) for the range. Ad metrics older than the
-- 90-day daily window come from whole-month totals.
create function public.ad_campaign_detail(p_campaign uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account uuid;
  v_scope text;
begin
  select c.ad_account_id into v_account from public.ad_campaigns c where c.id = p_campaign;
  v_scope := private.require_ad_access(v_account);
  if not exists (select 1 from private.visible_ad_campaigns(v_account, v_scope) c where c.id = p_campaign) then
    perform private.raise_forbidden();
  end if;
  perform private.check_ad_range(p_from, p_to);
  return (
    select jsonb_build_object(
      'campaign', jsonb_build_object('id', c.id, 'meta_id', c.meta_id, 'name', c.name, 'objective', c.objective, 'status', c.status,
        'effective_status', c.effective_status, 'daily_budget', c.daily_budget, 'lifetime_budget', c.lifetime_budget,
        'created_time', c.created_time, 'start_time', c.start_time, 'stop_time', c.stop_time,
        'category', (select jsonb_build_object('id', k.id, 'name', k.name) from public.ad_categories k where k.id = c.category_id)),
      'daily', (
        select coalesce(jsonb_agg(jsonb_build_object('date', g.day::date, 'spend', coalesce(d.spend, 0), 'impressions', coalesce(d.impressions, 0),
          'clicks', coalesce(d.clicks, 0), 'leads', coalesce(d.leads, 0), 'reach', coalesce(d.reach, 0)) order by g.day), '[]'::jsonb)
        from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)
        left join public.ad_campaign_daily d on d.campaign_id = c.id and d.date = g.day::date),
      'ads', (
        select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'meta_id', a.meta_id, 'name', a.name, 'status', a.status,
          'effective_status', a.effective_status, 'created_time', a.created_time, 'updated_time', a.updated_time,
          'thumbnail_url', a.thumbnail_url, 'preview_url', a.preview_url,
          'spend', coalesce(x.spend, 0) + coalesce(y.spend, 0), 'impressions', coalesce(x.impressions, 0) + coalesce(y.impressions, 0),
          'clicks', coalesce(x.clicks, 0) + coalesce(y.clicks, 0), 'leads', coalesce(x.leads, 0) + coalesce(y.leads, 0))
          order by a.created_time desc nulls last, a.id), '[]'::jsonb)
        from public.ad_ads a
        left join lateral (
          select sum(d.spend) as spend, sum(d.impressions) as impressions, sum(d.clicks) as clicks, sum(d.leads) as leads
          from public.ad_ad_daily d where d.ad_id = a.id and d.date between p_from and p_to) x on true
        left join lateral (
          select sum(m.spend) as spend, sum(m.impressions) as impressions, sum(m.clicks) as clicks, sum(m.leads) as leads
          from public.ad_ad_monthly m where m.ad_id = a.id and m.month between date_trunc('month', p_from)::date and p_to) y on true
        where a.campaign_id = c.id)
    )
    from public.ad_campaigns c where c.id = p_campaign
  );
end $$;

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
create function public.ad_categories_list(p_account uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope text := private.require_ad_access(p_account);
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'company_id', k.company_id, 'match_text', k.match_text,
      'campaigns', (select count(*) from public.ad_campaigns c where c.category_id = k.id))
      order by (k.company_id is null), lower(k.name)), '[]'::jsonb)
    from public.ad_categories k
    where k.ad_account_id = p_account and k.archived_at is null
      and (v_scope <> 'company' or k.company_id = private.current_company_id())
  );
end $$;

-- Puts uncategorised campaigns into the first category whose match text appears in their name.
create function private.auto_categorise_ads(p_account uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.ad_campaigns c set category_id = (
    select k.id from public.ad_categories k
    where k.ad_account_id = p_account and k.archived_at is null and k.match_text is not null
      and c.name ilike '%' || private.escape_like(k.match_text) || '%'
    order by (k.company_id is null), k.created_at, k.id limit 1)
  where c.ad_account_id = p_account and c.category_id is null
    and exists (select 1 from public.ad_categories k where k.ad_account_id = p_account and k.archived_at is null
      and k.match_text is not null and c.name ilike '%' || private.escape_like(k.match_text) || '%')
$$;

-- Creates (p_id null) or updates a category. A merged company's fixed category keeps its name.
create function public.save_ad_category(p_account uuid, p_id uuid, p_name text, p_match_text text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.ad_categories%rowtype;
  v_name text := private.clean_label(p_name);
  v_match text := private.clean_label(p_match_text);
  v_id uuid;
begin
  perform private.require_ad_access(p_account, true);
  if p_id is null then
    if v_name is null then
      raise exception 'invalid_category' using errcode = '22023';
    end if;
    insert into public.ad_categories (ad_account_id, name, match_text) values (p_account, left(v_name, 60), left(v_match, 60))
    returning id into v_id;
  else
    select * into v_row from public.ad_categories k where k.id = p_id and k.ad_account_id = p_account and k.archived_at is null for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    update public.ad_categories set
      name = case when v_row.company_id is null then coalesce(left(v_name, 60), name) else name end,
      match_text = left(v_match, 60)
    where id = p_id;
    v_id := p_id;
  end if;
  perform private.auto_categorise_ads(p_account);
  return v_id;
exception when unique_violation then
  raise exception 'duplicate_category' using errcode = '23505';
end $$;

create function public.archive_ad_category(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.ad_categories%rowtype;
begin
  select * into v_row from public.ad_categories k where k.id = p_id and k.archived_at is null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_ad_access(v_row.ad_account_id, true);
  if v_row.company_id is not null then
    raise exception 'category_fixed' using errcode = '22023';
  end if;
  update public.ad_campaigns set category_id = null where category_id = p_id;
  update public.ad_categories set archived_at = now() where id = p_id;
end $$;

create function public.set_ad_campaign_category(p_campaign_ids uuid[], p_category_id uuid)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid;
  v_count integer;
begin
  select distinct c.ad_account_id into v_account from public.ad_campaigns c where c.id = any(p_campaign_ids);
  if v_account is null or (select count(distinct c.ad_account_id) from public.ad_campaigns c where c.id = any(p_campaign_ids)) <> 1 then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_ad_access(v_account, true);
  if p_category_id is not null and not exists (
    select 1 from public.ad_categories k where k.id = p_category_id and k.ad_account_id = v_account and k.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.ad_campaigns set category_id = p_category_id where id = any(p_campaign_ids) and ad_account_id = v_account;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- Merging one company ad account across companies (super admin)
-- ---------------------------------------------------------------------------
-- Sets exactly which other companies share the account. Every company on it (the owner included)
-- gets a fixed category named after it; removed companies' categories are archived.
create function public.merge_ad_account(p_account uuid, p_company_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.ad_accounts%rowtype;
  v_ids uuid[];
  c record;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_row from public.ad_accounts a where a.id = p_account and a.kind = 'company' and a.archived_at is null for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_ids := array(select distinct x from unnest(coalesce(p_company_ids, '{}')) x where x <> v_row.company_id);
  if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.companies k where k.id = x and k.archived_at is null)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- A company uses one shared account at a time.
  if exists (select 1 from public.ad_account_members m where m.company_id = any(v_ids) and m.ad_account_id <> p_account) then
    raise exception 'already_merged' using errcode = '23514';
  end if;

  delete from public.ad_account_members m where m.ad_account_id = p_account and not (m.company_id = any(v_ids));
  insert into public.ad_account_members (ad_account_id, company_id) select p_account, x from unnest(v_ids) x on conflict do nothing;

  update public.ad_campaigns set category_id = null
  where ad_account_id = p_account and category_id in (
    select k.id from public.ad_categories k where k.ad_account_id = p_account and k.company_id is not null
      and k.archived_at is null and not (k.company_id = any(v_ids || v_row.company_id)));
  update public.ad_categories set archived_at = now()
  where ad_account_id = p_account and company_id is not null and archived_at is null and not (company_id = any(v_ids || v_row.company_id));

  if cardinality(v_ids) > 0 then
    for c in select k.id, k.name from public.companies k where k.id = any(v_ids || v_row.company_id) loop
      if not exists (select 1 from public.ad_categories k where k.ad_account_id = p_account and k.company_id = c.id and k.archived_at is null) then
        -- A custom category with the same name becomes the company's fixed one.
        update public.ad_categories set company_id = c.id
        where ad_account_id = p_account and archived_at is null and company_id is null
          and normalized_name = lower(regexp_replace(btrim(c.name), '\s+', ' ', 'g'));
        if not found then
          insert into public.ad_categories (ad_account_id, name, company_id, match_text) values (p_account, left(c.name, 60), c.id, left(c.name, 60));
        end if;
      end if;
    end loop;
  end if;
  perform private.auto_categorise_ads(p_account);
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ad_account_merged', jsonb_build_object('ad_account_id', p_account, 'company_ids', to_jsonb(v_ids)));
end $$;

create function public.super_ads_overview()
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
        where m.company_id = c.id and a.archived_at is null limit 1)
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c where c.archived_at is null
  );
end $$;

-- ---------------------------------------------------------------------------
-- Sync (service role only)
-- ---------------------------------------------------------------------------
create function public.ad_sync_targets(p_limit integer default 10)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select a.id from public.ad_accounts a
  where a.archived_at is null and not a.sync_paused and a.status = 'connected'
    and (a.next_sync_after is null or a.next_sync_after <= now())
  order by a.last_synced_at nulls first, a.id
  limit least(greatest(coalesce(p_limit, 10), 1), 50)
$$;

create function public.ad_account_secrets(p_account uuid)
returns table (
  id uuid, act_id text, app_id text, app_secret text, access_token text, timezone text,
  synced_through date, backfilled_from date, created_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select a.id, a.act_id, a.app_id,
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = a.app_secret_id),
    (select s.decrypted_secret from vault.decrypted_secrets s where s.id = a.access_token_id),
    a.timezone, a.synced_through, a.backfilled_from, a.created_at
  from public.ad_accounts a
  where a.id = p_account and a.archived_at is null
$$;

-- Records a check or sync outcome. A connected account that starts failing alerts the ads team once.
create function public.set_ad_account_state(
  p_account uuid, p_status text, p_error text default null, p_name text default null, p_currency text default null,
  p_timezone text default null, p_synced_through date default null, p_backfilled_from date default null,
  p_next_sync_after timestamptz default null, p_synced boolean default false
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old public.ad_accounts%rowtype;
begin
  select * into v_old from public.ad_accounts a where a.id = p_account for update;
  if not found then
    return;
  end if;
  update public.ad_accounts set
    status = p_status,
    last_error = left(p_error, 500),
    name = coalesce(left(p_name, 200), name),
    currency = coalesce(p_currency, currency),
    timezone = coalesce(left(p_timezone, 64), timezone),
    synced_through = coalesce(p_synced_through, synced_through),
    backfilled_from = coalesce(p_backfilled_from, backfilled_from),
    next_sync_after = p_next_sync_after,
    last_checked_at = now(),
    last_synced_at = case when p_synced then now() else last_synced_at end
  where id = p_account;
  if p_status = 'error' and v_old.status = 'connected' then
    perform private.enqueue_for_ads_team(v_old.company_id, 'ad_account_problem', jsonb_strip_nulls(jsonb_build_object(
      'ad_account_id', p_account, 'account_name', coalesce(v_old.name, 'act_' || v_old.act_id),
      'client', (select c.name from public.ads_clients c where c.id = v_old.ads_client_id),
      'ads_client_id', v_old.ads_client_id, 'error', left(p_error, 300))),
      'ad_account_problem:' || p_account || ':' || to_char(now(), 'YYYY-MM-DD'));
  end if;
end $$;

-- Campaigns and ads from Meta (upsert by Meta id), then automatic categorisation.
create function public.upsert_ad_entities(p_account uuid, p_campaigns jsonb, p_ads jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.ad_campaigns (ad_account_id, meta_id, name, objective, status, effective_status, daily_budget, lifetime_budget,
    created_time, start_time, stop_time)
  select p_account, x.meta_id, left(coalesce(x.name, x.meta_id), 400), x.objective, x.status, x.effective_status, x.daily_budget,
    x.lifetime_budget, x.created_time, x.start_time, x.stop_time
  from jsonb_to_recordset(coalesce(p_campaigns, '[]'::jsonb)) as x(meta_id text, name text, objective text, status text,
    effective_status text, daily_budget numeric, lifetime_budget numeric, created_time timestamptz, start_time timestamptz, stop_time timestamptz)
  where x.meta_id is not null
  on conflict (ad_account_id, meta_id) do update set
    name = excluded.name, objective = excluded.objective, status = excluded.status, effective_status = excluded.effective_status,
    daily_budget = excluded.daily_budget, lifetime_budget = excluded.lifetime_budget, created_time = excluded.created_time,
    start_time = excluded.start_time, stop_time = excluded.stop_time, updated_at = now();

  insert into public.ad_ads (ad_account_id, campaign_id, meta_id, name, status, effective_status, created_time, updated_time, thumbnail_url, preview_url)
  select p_account, c.id, x.meta_id, left(coalesce(x.name, x.meta_id), 400), x.status, x.effective_status, x.created_time, x.updated_time,
    left(x.thumbnail_url, 2000), left(x.preview_url, 2000)
  from jsonb_to_recordset(coalesce(p_ads, '[]'::jsonb)) as x(meta_id text, campaign_meta_id text, name text, status text,
    effective_status text, created_time timestamptz, updated_time timestamptz, thumbnail_url text, preview_url text)
  join public.ad_campaigns c on c.ad_account_id = p_account and c.meta_id = x.campaign_meta_id
  where x.meta_id is not null
  on conflict (ad_account_id, meta_id) do update set
    campaign_id = excluded.campaign_id, name = excluded.name, status = excluded.status, effective_status = excluded.effective_status,
    created_time = excluded.created_time, updated_time = excluded.updated_time,
    thumbnail_url = coalesce(excluded.thumbnail_url, public.ad_ads.thumbnail_url), preview_url = coalesce(excluded.preview_url, public.ad_ads.preview_url),
    updated_at = now();

  perform private.auto_categorise_ads(p_account);
end $$;

-- Daily insight rows (p_level 'campaign' or 'ad'). Rows for campaigns/ads Meta no longer lists
-- (deleted ones still have history) create minimal placeholders.
create function public.upsert_ad_insights(p_account uuid, p_level text, p_rows jsonb)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_level not in ('campaign', 'ad') then
    raise exception 'invalid_level' using errcode = '22023';
  end if;
  create temporary table if not exists pg_temp.ad_rows (
    campaign_meta_id text, campaign_name text, ad_meta_id text, ad_name text, date date,
    spend numeric, impressions bigint, reach bigint, clicks bigint, link_clicks bigint, leads bigint,
    conversions bigint, conversion_value numeric, actions jsonb
  ) on commit drop;
  truncate pg_temp.ad_rows;
  insert into pg_temp.ad_rows
  select * from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(
    campaign_meta_id text, campaign_name text, ad_meta_id text, ad_name text, date date,
    spend numeric, impressions bigint, reach bigint, clicks bigint, link_clicks bigint, leads bigint,
    conversions bigint, conversion_value numeric, actions jsonb)
  where x.campaign_meta_id is not null and x.date is not null and (p_level = 'campaign' or x.ad_meta_id is not null);

  insert into public.ad_campaigns (ad_account_id, meta_id, name)
  select distinct on (r.campaign_meta_id) p_account, r.campaign_meta_id, left(coalesce(r.campaign_name, r.campaign_meta_id), 400)
  from pg_temp.ad_rows r
  on conflict (ad_account_id, meta_id) do nothing;

  if p_level = 'campaign' then
    insert into public.ad_campaign_daily (campaign_id, date, ad_account_id, spend, impressions, reach, clicks, link_clicks, leads,
      conversions, conversion_value, actions)
    select c.id, r.date, p_account, coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.reach, 0), coalesce(r.clicks, 0),
      coalesce(r.link_clicks, 0), coalesce(r.leads, 0), coalesce(r.conversions, 0), coalesce(r.conversion_value, 0), r.actions
    from pg_temp.ad_rows r join public.ad_campaigns c on c.ad_account_id = p_account and c.meta_id = r.campaign_meta_id
    on conflict (campaign_id, date) do update set
      spend = excluded.spend, impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks,
      link_clicks = excluded.link_clicks, leads = excluded.leads, conversions = excluded.conversions,
      conversion_value = excluded.conversion_value, actions = excluded.actions, updated_at = now();
  else
    insert into public.ad_ads (ad_account_id, campaign_id, meta_id, name)
    select distinct on (r.ad_meta_id) p_account, c.id, r.ad_meta_id, left(coalesce(r.ad_name, r.ad_meta_id), 400)
    from pg_temp.ad_rows r join public.ad_campaigns c on c.ad_account_id = p_account and c.meta_id = r.campaign_meta_id
    on conflict (ad_account_id, meta_id) do nothing;

    insert into public.ad_ad_daily (ad_id, date, ad_account_id, campaign_id, spend, impressions, reach, clicks, link_clicks, leads,
      conversions, conversion_value)
    select a.id, r.date, p_account, a.campaign_id, coalesce(r.spend, 0), coalesce(r.impressions, 0), coalesce(r.reach, 0),
      coalesce(r.clicks, 0), coalesce(r.link_clicks, 0), coalesce(r.leads, 0), coalesce(r.conversions, 0), coalesce(r.conversion_value, 0)
    from pg_temp.ad_rows r join public.ad_ads a on a.ad_account_id = p_account and a.meta_id = r.ad_meta_id
    -- Days already rolled up into a month are not reopened.
    where r.date >= (select coalesce(max(m.month + interval '1 month')::date, '-infinity'::date)
                     from public.ad_ad_monthly m where m.ad_id = a.id)
    on conflict (ad_id, date) do update set
      spend = excluded.spend, impressions = excluded.impressions, reach = excluded.reach, clicks = excluded.clicks,
      link_clicks = excluded.link_clicks, leads = excluded.leads, conversions = excluded.conversions,
      conversion_value = excluded.conversion_value;
  end if;
  get diagnostics v_count = row_count;
  perform private.auto_categorise_ads(p_account);
  return v_count;
end $$;

-- Whole-month unique reach (campaign_meta_id null = the whole account).
create function public.upsert_ad_reach(p_account uuid, p_rows jsonb)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.ad_reach_monthly (ad_account_id, campaign_id, month, reach)
  select p_account, c.id, date_trunc('month', x.month)::date, coalesce(x.reach, 0)
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as x(campaign_meta_id text, month date, reach bigint)
  left join public.ad_campaigns c on c.ad_account_id = p_account and c.meta_id = x.campaign_meta_id
  where x.month is not null and (x.campaign_meta_id is null or c.id is not null)
  on conflict (ad_account_id, campaign_id, month) do update set reach = excluded.reach
$$;

-- Daily per-ad rows older than 90 days (whole months only) become monthly rows.
create function private.rollup_ad_daily()
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_cutoff date := date_trunc('month', current_date - 90)::date;
  v_count integer;
begin
  insert into public.ad_ad_monthly (ad_id, month, ad_account_id, campaign_id, spend, impressions, reach, clicks, link_clicks, leads,
    conversions, conversion_value)
  select d.ad_id, date_trunc('month', d.date)::date, d.ad_account_id, d.campaign_id, sum(d.spend), sum(d.impressions), sum(d.reach),
    sum(d.clicks), sum(d.link_clicks), sum(d.leads), sum(d.conversions), sum(d.conversion_value)
  from public.ad_ad_daily d where d.date < v_cutoff
  group by d.ad_id, date_trunc('month', d.date), d.ad_account_id, d.campaign_id
  on conflict (ad_id, month) do update set
    spend = public.ad_ad_monthly.spend + excluded.spend, impressions = public.ad_ad_monthly.impressions + excluded.impressions,
    reach = public.ad_ad_monthly.reach + excluded.reach, clicks = public.ad_ad_monthly.clicks + excluded.clicks,
    link_clicks = public.ad_ad_monthly.link_clicks + excluded.link_clicks, leads = public.ad_ad_monthly.leads + excluded.leads,
    conversions = public.ad_ad_monthly.conversions + excluded.conversions,
    conversion_value = public.ad_ad_monthly.conversion_value + excluded.conversion_value;
  delete from public.ad_ad_daily where date < v_cutoff;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Hourly: asks the app to sync the most stale ad accounts (same Vault pattern as the reminder worker).
create function private.invoke_ads_sync()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'crm_app_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'crm_ads_sync_secret';
  if v_url is null or v_secret is null then
    raise warning 'crm ads sync: vault secrets crm_app_url / crm_ads_sync_secret are missing';
    return;
  end if;
  if not exists (select 1 from public.ad_accounts a where a.archived_at is null and not a.sync_paused and a.status = 'connected') then
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/api/ads/sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
end $$;

-- ---------------------------------------------------------------------------
-- Facebook Lead Ads insights (Automation → Facebook Lead Ads → View insights)
-- ---------------------------------------------------------------------------
create function public.set_meta_lead_ad_ids(p_company_id uuid, p_leadgen_id text, p_campaign_id text, p_adset_id text, p_ad_id text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead uuid;
begin
  p_campaign_id := left(nullif(btrim(p_campaign_id), ''), 40);
  p_adset_id := left(nullif(btrim(p_adset_id), ''), 40);
  p_ad_id := left(nullif(btrim(p_ad_id), ''), 40);
  update public.meta_lead_events set campaign_id = p_campaign_id, adset_id = p_adset_id, ad_id = p_ad_id
  where company_id = p_company_id and leadgen_id = p_leadgen_id
  returning lead_id into v_lead;
  if v_lead is not null then
    update public.leads set source_meta = coalesce(source_meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'campaign_id', p_campaign_id, 'adset_id', p_adset_id, 'ad_id', p_ad_id))
    where id = v_lead and source = 'facebook' and coalesce(source_meta ->> 'leadgen_id', '') = p_leadgen_id;
  end if;
end $$;

create function public.meta_lead_insights(p_company_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  perform private.check_ad_range(p_from, p_to);
  with e as (
    select e.*, (e.created_at at time zone 'Asia/Kolkata')::date as day
    from public.meta_lead_events e
    where e.company_id = p_company_id
      and e.created_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and e.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ), made as (
    select e.*, l.status, l.owner_id, l.stage_id from e join public.leads l on l.id = e.lead_id where e.state = 'created'
  ), spend as (
    select c.meta_id, sum(d.spend) as spend, max(a.currency) as currency
    from public.ad_campaigns c
    join public.ad_accounts a on a.id = c.ad_account_id and a.kind = 'company'
      and (a.company_id = p_company_id or exists (select 1 from public.ad_account_members m where m.ad_account_id = a.id and m.company_id = p_company_id))
    join public.ad_campaign_daily d on d.campaign_id = c.id and d.date between p_from and p_to
    where c.meta_id in (select distinct e.campaign_id from e where e.campaign_id is not null)
    group by c.meta_id
  )
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'days', p_to - p_from + 1),
    'totals', jsonb_build_object(
      'received', (select count(*) from e),
      'created', (select count(*) from e where e.state = 'created'),
      'duplicate', (select count(*) from e where e.state = 'duplicate'),
      'failed', (select count(*) from e where e.state = 'failed'),
      'open', (select count(*) from made where made.status = 'open'),
      'won', (select count(*) from made where made.status = 'won'),
      'lost', (select count(*) from made where made.status = 'lost'),
      'spend', (select sum(s.spend) from spend s),
      'currency', (select max(s.currency) from spend s)),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('date', g.day::date,
        'created', (select count(*) from e where e.day = g.day::date and e.state = 'created'),
        'duplicate', (select count(*) from e where e.day = g.day::date and e.state = 'duplicate'),
        'failed', (select count(*) from e where e.day = g.day::date and e.state = 'failed')) order by g.day), '[]'::jsonb)
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)),
    'forms', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'leads', t.leads, 'won', t.won) order by t.leads desc, t.name), '[]'::jsonb)
      from (select coalesce(e.form_name, 'Unknown form') as name,
              count(*) filter (where e.state in ('created', 'duplicate')) as leads,
              count(*) filter (where e.state = 'created' and l.status = 'won') as won
            from e left join public.leads l on l.id = e.lead_id
            group by 1 order by 2 desc limit 20) t),
    'campaigns', (
      select coalesce(jsonb_agg(jsonb_build_object('campaign_id', t.campaign_id, 'name', t.name, 'leads', t.leads, 'won', t.won,
        'spend', s.spend, 'cpl', case when t.leads > 0 and s.spend is not null then round(s.spend / t.leads, 2) end,
        'cost_per_won', case when t.won > 0 and s.spend is not null then round(s.spend / t.won, 2) end)
        order by t.leads desc, t.name), '[]'::jsonb)
      from (select e.campaign_id, coalesce(max(e.campaign_name), 'Unknown campaign') as name, count(*) as leads,
              count(*) filter (where l.status = 'won') as won
            from e left join public.leads l on l.id = e.lead_id and e.state = 'created'
            where e.state = 'created'
            group by e.campaign_id, coalesce(e.campaign_name, '') limit 30) t
      left join spend s on s.meta_id = t.campaign_id),
    'ads', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'leads', t.leads, 'won', t.won) order by t.leads desc, t.name), '[]'::jsonb)
      from (select coalesce(e.ad_name, 'Unknown ad') as name, count(*) as leads, count(*) filter (where l.status = 'won') as won
            from e left join public.leads l on l.id = e.lead_id
            where e.state = 'created' group by coalesce(e.ad_name, 'Unknown ad') order by count(*) desc limit 15) t),
    'owners', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.owner_id, 'name', coalesce(private.display_name(t.owner_id), 'Unassigned'),
        'leads', t.leads, 'open', t.open, 'won', t.won, 'lost', t.lost) order by t.leads desc), '[]'::jsonb)
      from (select m.owner_id, count(*) as leads, count(*) filter (where m.status = 'open') as open,
              count(*) filter (where m.status = 'won') as won, count(*) filter (where m.status = 'lost') as lost
            from made m group by m.owner_id) t),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', t.cnt)
        order by s.position), '[]'::jsonb)
      from (select m.stage_id, count(*) as cnt from made m group by m.stage_id) t
      join public.pipeline_stages s on s.id = t.stage_id)
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Schedules
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-ads-sync', '23 * * * *', 'select private.invoke_ads_sync()');
    perform cron.schedule('crm-ads-rollup', '41 3 * * *', 'select private.rollup_ad_daily()');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.ad_access(uuid),
  private.require_ad_access(uuid, boolean),
  private.visible_ad_campaigns(uuid, text),
  private.check_ad_range(date, date),
  private.ad_account_json(public.ad_accounts, text),
  private.disconnect_ad_account_row(uuid),
  private.auto_categorise_ads(uuid),
  private.rollup_ad_daily(),
  private.invoke_ads_sync(),
  public.ads_accounts_for_me(),
  public.ad_account_detail(uuid),
  public.save_ad_account(text, uuid, text, text, text, text, boolean),
  public.disconnect_ad_account(uuid),
  public.ads_overview(uuid, date, date, uuid, boolean),
  public.list_ad_campaigns(uuid, date, date, uuid, boolean, text, text, text, text, integer, integer),
  public.ad_campaign_detail(uuid, date, date),
  public.ad_categories_list(uuid),
  public.save_ad_category(uuid, uuid, text, text),
  public.archive_ad_category(uuid),
  public.set_ad_campaign_category(uuid[], uuid),
  public.merge_ad_account(uuid, uuid[]),
  public.super_ads_overview(),
  public.ad_sync_targets(integer),
  public.ad_account_secrets(uuid),
  public.set_ad_account_state(uuid, text, text, text, text, text, date, date, timestamptz, boolean),
  public.upsert_ad_entities(uuid, jsonb, jsonb),
  public.upsert_ad_insights(uuid, text, jsonb),
  public.upsert_ad_reach(uuid, jsonb),
  public.set_meta_lead_ad_ids(uuid, text, text, text, text),
  public.meta_lead_insights(uuid, date, date)
from public, anon, authenticated;

grant execute on function
  public.ads_accounts_for_me(),
  public.ad_account_detail(uuid),
  public.save_ad_account(text, uuid, text, text, text, text, boolean),
  public.disconnect_ad_account(uuid),
  public.ads_overview(uuid, date, date, uuid, boolean),
  public.list_ad_campaigns(uuid, date, date, uuid, boolean, text, text, text, text, integer, integer),
  public.ad_campaign_detail(uuid, date, date),
  public.ad_categories_list(uuid),
  public.save_ad_category(uuid, uuid, text, text),
  public.archive_ad_category(uuid),
  public.set_ad_campaign_category(uuid[], uuid),
  public.merge_ad_account(uuid, uuid[]),
  public.super_ads_overview(),
  public.meta_lead_insights(uuid, date, date)
to authenticated;

grant execute on function
  public.ad_sync_targets(integer),
  public.ad_account_secrets(uuid),
  public.set_ad_account_state(uuid, text, text, text, text, text, date, date, timestamptz, boolean),
  public.upsert_ad_entities(uuid, jsonb, jsonb),
  public.upsert_ad_insights(uuid, text, jsonb),
  public.upsert_ad_reach(uuid, jsonb),
  public.set_meta_lead_ad_ids(uuid, text, text, text, text)
to service_role;
