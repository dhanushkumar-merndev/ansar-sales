-- ---------------------------------------------------------------------------
-- Campaign table: also "ran in the last 7 / 14 / 28 days" (p_status 'ran_7' / 'ran_14' / 'ran_28'),
-- which includes campaigns paused since. Same signature; the numbers still cover p_from..p_to.
-- ---------------------------------------------------------------------------

create or replace function public.list_ad_campaigns(
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
  -- "ran_7" / "ran_14" / "ran_28": spent money on at least one of the last N days of the account's calendar.
  v_ran_days integer := case when p_status in ('ran_7', 'ran_14', 'ran_28') then substring(p_status from 5)::integer end;
  v_today date := (now() at time zone coalesce((select a.timezone from public.ad_accounts a where a.id = p_account), 'Asia/Kolkata'))::date;
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  perform private.check_ad_range(p_from, p_to);
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if p_sort not in ('spend', 'name', 'created', 'leads', 'cpl', 'ctr', 'impressions', 'last_active') or p_dir not in ('asc', 'desc')
     or (p_status is not null and p_status not in ('active', 'inactive', 'ran_7', 'ran_14', 'ran_28')) then
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
      and (p_status is null
        or (v_ran_days is null and (p_status = 'active') = (c.effective_status = 'ACTIVE'))
        or (v_ran_days is not null and exists (select 1 from public.ad_campaign_daily x
              where x.campaign_id = c.id and x.spend > 0 and x.date > v_today - v_ran_days)))
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
