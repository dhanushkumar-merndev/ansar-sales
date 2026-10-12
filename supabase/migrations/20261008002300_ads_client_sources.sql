-- ---------------------------------------------------------------------------
-- Where an ads client's ads run. Besides the client's own Meta ad account (ad_accounts kind
-- 'client'), the agency can run them on its own company ad account: a category of that account
-- is linked to the client (ad_categories.ads_client_id), like a merged company's fixed category.
--
-- * The client's portal login sees only that category's campaigns on the agency account
--   (scope 'client_category'); whole-account figures (categories, unique monthly reach) stay hidden.
-- * A linked category can't be renamed or removed until it is unlinked on the client's page.
-- * A client needs at least one source (a live own account, or a linked category on a live agency
--   account) before going Active. Onboarding clients may have none yet.
-- * Results add sources together only per currency (ads_client_summary).
-- ---------------------------------------------------------------------------

alter table public.ad_categories add column ads_client_id uuid references public.ads_clients (id);
alter table public.ad_categories add constraint ad_categories_owner_check check (company_id is null or ads_client_id is null);
create unique index ad_categories_client_key on public.ad_categories (ad_account_id, ads_client_id)
  where ads_client_id is not null and archived_at is null;
create index ad_categories_client_idx on public.ad_categories (ads_client_id) where ads_client_id is not null;
-- Per-category totals (client summaries) look campaigns up by category alone.
create index ad_campaigns_category_only_idx on public.ad_campaigns (category_id) where category_id is not null;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
create or replace function private.ad_access(p_account uuid)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when private.is_super_admin() then 'all'
    when private.is_ads_user() and a.company_id = private.current_company_id() then 'all'
    when private.is_ads_user() and a.kind = 'company' and exists (
      select 1 from public.ad_account_members m where m.ad_account_id = a.id and m.company_id = private.current_company_id()) then 'company'
    when a.kind = 'client' and a.ads_client_id = private.my_ads_client_id() then 'client'
    when a.kind = 'company' and exists (
      select 1 from public.ad_categories k where k.ad_account_id = a.id and k.ads_client_id = private.my_ads_client_id()) then 'client_category'
  end
  from public.ad_accounts a where a.id = p_account
$$;

-- The campaigns of an account the caller may see ('company' / 'client_category': one category only).
create or replace function private.visible_ad_campaigns(p_account uuid, p_scope text)
returns setof public.ad_campaigns
language sql stable security definer set search_path = ''
as $$
  select c.* from public.ad_campaigns c
  where c.ad_account_id = p_account
    and (p_scope <> 'company' or c.category_id in (
      select k.id from public.ad_categories k
      where k.ad_account_id = p_account and k.company_id = private.current_company_id() and k.archived_at is null))
    and (p_scope <> 'client_category' or c.category_id in (
      select k.id from public.ad_categories k
      where k.ad_account_id = p_account and k.ads_client_id = private.my_ads_client_id()))
$$;

-- Unchanged except that whole-account figures are shown only to full ('all') and own-account ('client') scopes.
create or replace function public.ads_overview(
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
      when v_scope in ('all', 'client') and p_category is null and not coalesce(p_uncategorised, false)
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
    'categories', case when v_scope in ('all', 'client') then (
      select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', coalesce(k.name, 'Uncategorised'), 'company_id', k.company_id,
        'spend', x.spend, 'leads', x.leads) order by x.spend desc), '[]'::jsonb)
      from (
        select c.category_id, sum(d.spend) as spend, sum(d.leads) as leads
        from d join camps c on c.id = d.campaign_id group by c.category_id
      ) x left join public.ad_categories k on k.id = x.category_id) end
  ) into v_result;
  return v_result;
end $$;

create or replace function public.ad_categories_list(p_account uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_scope text := private.require_ad_access(p_account);
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'company_id', k.company_id, 'match_text', k.match_text,
      'ads_client_id', k.ads_client_id, 'client_name', (select c.name from public.ads_clients c where c.id = k.ads_client_id),
      'campaigns', (select count(*) from public.ad_campaigns c where c.category_id = k.id))
      order by (k.company_id is null), (k.ads_client_id is null), lower(k.name)), '[]'::jsonb)
    from public.ad_categories k
    where k.ad_account_id = p_account and k.archived_at is null
      and (v_scope <> 'company' or k.company_id = private.current_company_id())
      and (v_scope <> 'client_category' or k.ads_client_id = private.my_ads_client_id())
  );
end $$;

-- ---------------------------------------------------------------------------
-- Categories: a client's category keeps its name and can't be removed while linked
-- ---------------------------------------------------------------------------
create or replace function public.save_ad_category(p_account uuid, p_id uuid, p_name text, p_match_text text default null)
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
      name = case when v_row.company_id is null and v_row.ads_client_id is null then coalesce(left(v_name, 60), name) else name end,
      match_text = left(v_match, 60)
    where id = p_id;
    v_id := p_id;
  end if;
  perform private.auto_categorise_ads(p_account);
  return v_id;
exception when unique_violation then
  raise exception 'duplicate_category' using errcode = '23505';
end $$;

create or replace function public.archive_ad_category(p_id uuid)
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
  if v_row.ads_client_id is not null then
    raise exception 'category_client' using errcode = '22023';
  end if;
  update public.ad_campaigns set category_id = null where category_id = p_id;
  update public.ad_categories set archived_at = now() where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Linking a client to a category of the agency's own ad account
-- ---------------------------------------------------------------------------
-- p_create: a category named after the client (an unlinked one with that name is reused).
-- p_category: link that existing category. Neither: unlink (stop running on the agency account).
-- The client's previous category on the account is unlinked; its campaigns stay in it.
create function public.set_ads_client_category(p_client uuid, p_category uuid default null, p_create boolean default false)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.require_ads_client(p_client);
  v_client public.ads_clients%rowtype;
  v_account uuid;
  v_cat public.ad_categories%rowtype;
  v_name text;
  v_id uuid;
begin
  select * into v_client from public.ads_clients c where c.id = p_client for update;
  select a.id into v_account from public.ad_accounts a
  where a.company_id = v_company and a.kind = 'company' and a.archived_at is null;
  if v_account is null then
    raise exception 'no_agency_ad_account' using errcode = '22023';
  end if;
  perform private.require_ad_access(v_account, true);

  if coalesce(p_create, false) then
    v_name := left(coalesce(private.clean_label(v_client.business), private.clean_label(v_client.name)), 60);
    select * into v_cat from public.ad_categories k
    where k.ad_account_id = v_account and k.archived_at is null
      and k.normalized_name = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g')) for update;
    if found and (v_cat.company_id is not null or (v_cat.ads_client_id is not null and v_cat.ads_client_id <> p_client)) then
      raise exception 'category_taken' using errcode = '23514';
    end if;
    v_id := v_cat.id;
  elsif p_category is not null then
    select * into v_cat from public.ad_categories k where k.id = p_category and k.ad_account_id = v_account and k.archived_at is null for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if v_cat.company_id is not null or (v_cat.ads_client_id is not null and v_cat.ads_client_id <> p_client) then
      raise exception 'category_taken' using errcode = '23514';
    end if;
    v_id := v_cat.id;
  end if;

  update public.ad_categories set ads_client_id = null
  where ad_account_id = v_account and ads_client_id = p_client and id is distinct from v_id;
  if coalesce(p_create, false) and v_id is null then
    insert into public.ad_categories (ad_account_id, name, ads_client_id) values (v_account, v_name, p_client) returning id into v_id;
  elsif v_id is not null then
    update public.ad_categories set ads_client_id = p_client where id = v_id;
  end if;
  perform private.auto_categorise_ads(v_account);
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_category', jsonb_build_object('ads_client_id', p_client, 'ad_account_id', v_account, 'category_id', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Results per source
-- ---------------------------------------------------------------------------
-- One row per source with its totals for the range: every category linked to the client (on any
-- company account, disconnected ones included for history) and every own account of the client.
create function private.ads_client_sources(p_client uuid, p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(x.j order by x.sort, x.archived, x.created_at desc), '[]'::jsonb)
  from (
    select 0 as sort, a.archived_at is not null as archived, a.created_at,
      jsonb_build_object('source', 'agency', 'account_id', a.id, 'category_id', k.id, 'category_name', k.name,
        'currency', a.currency, 'archived', a.archived_at is not null) || t.totals as j
    from public.ad_categories k
    join public.ad_accounts a on a.id = k.ad_account_id
    cross join lateral (
      select jsonb_build_object('spend', coalesce(sum(d.spend), 0), 'impressions', coalesce(sum(d.impressions), 0),
        'clicks', coalesce(sum(d.clicks), 0), 'link_clicks', coalesce(sum(d.link_clicks), 0), 'leads', coalesce(sum(d.leads), 0),
        'conversions', coalesce(sum(d.conversions), 0)) as totals
      from public.ad_campaigns c
      join public.ad_campaign_daily d on d.campaign_id = c.id and d.date between p_from and p_to
      where c.category_id = k.id) t
    where k.ads_client_id = p_client and k.archived_at is null
    union all
    select 1, a.archived_at is not null, a.created_at,
      jsonb_build_object('source', 'own', 'account_id', a.id, 'category_id', null, 'category_name', null,
        'currency', a.currency, 'archived', a.archived_at is not null) || t.totals
    from public.ad_accounts a
    cross join lateral (
      select jsonb_build_object('spend', coalesce(sum(d.spend), 0), 'impressions', coalesce(sum(d.impressions), 0),
        'clicks', coalesce(sum(d.clicks), 0), 'link_clicks', coalesce(sum(d.link_clicks), 0), 'leads', coalesce(sum(d.leads), 0),
        'conversions', coalesce(sum(d.conversions), 0)) as totals
      from public.ad_campaign_daily d where d.ad_account_id = a.id and d.date between p_from and p_to) t
    where a.ads_client_id = p_client
  ) x
$$;

-- Totals per currency of the given sources (never adds different currencies together).
create function private.ads_currency_totals(p_sources jsonb)
returns jsonb
language sql immutable set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('currency', g.currency, 'spend', g.spend, 'impressions', g.impressions,
    'clicks', g.clicks, 'link_clicks', g.link_clicks, 'leads', g.leads, 'conversions', g.conversions) order by g.spend desc), '[]'::jsonb)
  from (
    select s ->> 'currency' as currency, sum((s ->> 'spend')::numeric) as spend, sum((s ->> 'impressions')::numeric) as impressions,
      sum((s ->> 'clicks')::numeric) as clicks, sum((s ->> 'link_clicks')::numeric) as link_clicks,
      sum((s ->> 'leads')::numeric) as leads, sum((s ->> 'conversions')::numeric) as conversions
    from jsonb_array_elements(p_sources) s group by 1
  ) g
$$;

-- For the client's page (ads team) and the client's own portal.
create function public.ads_client_summary(p_client uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_sources jsonb;
begin
  if private.my_ads_client_id() is distinct from p_client then
    perform private.require_ads_client(p_client);
  end if;
  perform private.check_ad_range(p_from, p_to);
  v_sources := private.ads_client_sources(p_client, p_from, p_to);
  return jsonb_build_object('sources', v_sources, 'totals', private.ads_currency_totals(v_sources),
    'range', jsonb_build_object('from', p_from, 'to', p_to));
end $$;

-- Whether a client has a working source: a live own account, or a linked category on a live agency account.
create function private.ads_client_has_source(p_client uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.ad_accounts a where a.ads_client_id = p_client and a.archived_at is null)
    or exists (select 1 from public.ad_categories k join public.ad_accounts a on a.id = k.ad_account_id
      where k.ads_client_id = p_client and k.archived_at is null and a.archived_at is null)
$$;

-- ---------------------------------------------------------------------------
-- Clients: list, detail, portal, status
-- ---------------------------------------------------------------------------
create or replace function public.list_ads_clients(
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
      'sources', jsonb_build_object(
        'own', exists (select 1 from public.ad_accounts a where a.ads_client_id = c.id and a.archived_at is null),
        'agency', exists (select 1 from public.ad_categories k join public.ad_accounts a on a.id = k.ad_account_id
          where k.ads_client_id = c.id and k.archived_at is null and a.archived_at is null)),
      'last_30d', private.ads_currency_totals(private.ads_client_sources(c.id, v_today - 29, v_today)),
      'logins', (select count(*) from public.profiles p where p.ads_client_id = c.id and p.is_active)
    ) order by pg.rn), '[]'::jsonb)
    from page pg join public.ads_clients c on c.id = pg.id)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

create or replace function public.ads_client_detail(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.require_ads_client(p_id);
begin
  return (
    select private.ads_client_json(c) || jsonb_build_object(
      'company_name', (select k.name from public.companies k where k.id = c.company_id),
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

-- The signed-in client's portal: their business, the agency brand, their own ad accounts and the
-- agency account categories run for them.
create or replace function public.my_portal()
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
        from public.ad_accounts a where a.ads_client_id = c.id), '[]'::jsonb),
      'agency_sources', coalesce((select jsonb_agg(jsonb_build_object('category_id', k.id, 'category_name', k.name,
          'account', private.ad_account_json(a, 'client_category')) order by a.archived_at nulls first, a.created_at desc)
        from public.ad_categories k join public.ad_accounts a on a.id = k.ad_account_id
        where k.ads_client_id = c.id and k.archived_at is null), '[]'::jsonb))
    from public.ads_clients c where c.id = v_client
  );
end $$;

-- Closing stops syncing (history stays) and by default disables the client's logins.
-- Reopening resumes syncing; the next sync back-fills the gap. Going Active needs an ad source.
create or replace function public.set_ads_client_status(p_id uuid, p_status text, p_disable_logins boolean default true)
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
  if p_status = 'active' and v_old.status <> 'active' and not private.ads_client_has_source(p_id) then
    raise exception 'ads_source_required' using errcode = '23514';
  end if;
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
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  private.ads_client_sources(uuid, date, date),
  private.ads_currency_totals(jsonb),
  private.ads_client_has_source(uuid),
  public.set_ads_client_category(uuid, uuid, boolean),
  public.ads_client_summary(uuid, date, date)
from public, anon, authenticated;

grant execute on function
  public.set_ads_client_category(uuid, uuid, boolean),
  public.ads_client_summary(uuid, date, date)
to authenticated;
