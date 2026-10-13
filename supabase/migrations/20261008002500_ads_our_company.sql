-- ---------------------------------------------------------------------------
-- Ads dashboard: "our company" vs client categories, and picking several categories.
--
-- * ad_categories.in_dashboard: ON = our company (counted in the Ads dashboard by default),
--   OFF = a client's campaigns run on our account. A category linked to an ads client is OFF
--   by default (trigger below); anyone who manages the account can switch it.
-- * ads_overview / list_ad_campaigns get three optional filters:
--     p_ours                 only campaigns in ON categories plus uncategorised ones (whole-account
--                            viewers only; merged companies and clients already see just their part)
--     p_categories           only these categories ...
--     p_with_uncategorised   ... plus uncategorised campaigns
--   Callers that don't pass them see exactly what they saw before.
-- * ads_overview also returns up to 20 campaigns for the per-campaign charts (was 12).
-- ---------------------------------------------------------------------------

alter table public.ad_categories add column in_dashboard boolean not null default true;
update public.ad_categories set in_dashboard = false where ads_client_id is not null;

-- Linking a category to an ads client moves it to "Clients"; unlinking moves it back.
create function private.ad_category_client_default()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.ads_client_id is not null then new.in_dashboard := false; end if;
  elsif new.ads_client_id is distinct from old.ads_client_id then
    new.in_dashboard := new.ads_client_id is null;
  end if;
  return new;
end $$;

create trigger ad_categories_client_default before insert or update of ads_client_id on public.ad_categories
  for each row execute function private.ad_category_client_default();

create function public.set_ad_category_dashboard(p_id uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid;
begin
  select k.ad_account_id into v_account from public.ad_categories k where k.id = p_id and k.archived_at is null;
  if v_account is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.require_ad_access(v_account, true);
  update public.ad_categories set in_dashboard = coalesce(p_on, true) where id = p_id;
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
      'in_dashboard', k.in_dashboard, 'ads_client_id', k.ads_client_id, 'client_name', (select c.name from public.ads_clients c where c.id = k.ads_client_id),
      'campaigns', (select count(*) from public.ad_campaigns c where c.category_id = k.id))
      order by (k.company_id is null), (k.ads_client_id is null), lower(k.name)), '[]'::jsonb)
    from public.ad_categories k
    where k.ad_account_id = p_account and k.archived_at is null
      and (v_scope <> 'company' or k.company_id = private.current_company_id())
      and (v_scope <> 'client_category' or k.ads_client_id = private.my_ads_client_id())
  );
end $$;

-- New optional arguments: drop the old signatures so no ambiguous overloads remain.
drop function public.ads_overview(uuid, date, date, uuid, boolean);
drop function public.list_ad_campaigns(uuid, date, date, uuid, boolean, text, text, text, text, integer, integer);

create function public.ads_overview(
  p_account uuid, p_from date, p_to date, p_category uuid default null, p_uncategorised boolean default false,
  p_ours boolean default false, p_categories uuid[] default null, p_with_uncategorised boolean default false
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
      and (not coalesce(p_ours, false) or v_scope <> 'all' or c.category_id is null
        or exists (select 1 from public.ad_categories k where k.id = c.category_id and k.in_dashboard))
      and (p_categories is null or c.category_id = any(p_categories) or (coalesce(p_with_uncategorised, false) and c.category_id is null))
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
       and p_categories is null
       and (not coalesce(p_ours, false) or not exists (select 1 from public.ad_categories k
         where k.ad_account_id = p_account and k.archived_at is null and not k.in_dashboard))
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
        limit 20
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

create function public.list_ad_campaigns(
  p_account uuid, p_from date, p_to date,
  p_category uuid default null, p_uncategorised boolean default false,
  p_search text default null, p_status text default null,
  p_sort text default 'spend', p_dir text default 'desc',
  p_limit integer default 20, p_offset integer default 0,
  p_ours boolean default false, p_categories uuid[] default null, p_with_uncategorised boolean default false
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
      and (not coalesce(p_ours, false) or v_scope <> 'all' or c.category_id is null
        or exists (select 1 from public.ad_categories k where k.id = c.category_id and k.in_dashboard))
      and (p_categories is null or c.category_id = any(p_categories) or (coalesce(p_with_uncategorised, false) and c.category_id is null))
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

revoke all on function
  private.ad_category_client_default(),
  public.set_ad_category_dashboard(uuid, boolean),
  public.ads_overview(uuid, date, date, uuid, boolean, boolean, uuid[], boolean),
  public.list_ad_campaigns(uuid, date, date, uuid, boolean, text, text, text, text, integer, integer, boolean, uuid[], boolean)
from public, anon, authenticated;

grant execute on function
  public.set_ad_category_dashboard(uuid, boolean),
  public.ads_overview(uuid, date, date, uuid, boolean, boolean, uuid[], boolean),
  public.list_ad_campaigns(uuid, date, date, uuid, boolean, text, text, text, text, integer, integer, boolean, uuid[], boolean)
to authenticated;
