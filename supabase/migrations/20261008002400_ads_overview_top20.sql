-- The Ads dashboard's per-campaign charts show the top 6 and can expand to the top 20,
-- so ads_overview returns up to 20 campaigns (was 12). Otherwise unchanged from 20261008002300.
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
