-- ---------------------------------------------------------------------------
-- Several ad categories per company of ours. Every Facebook lead from a campaign in one of a
-- company's categories goes to that company's CRM (ingest_meta_lead, v_mapped), and the company
-- sees those campaigns on its Ads page. Set from Super settings → Facebook leads (and Ads).
--
-- * The one-category-per-company index goes.
-- * set_company_ad_categories: the super admin sets the whole list for a company; a company that
--   doesn't share the account yet joins it (as "Also runs campaigns for" does).
-- * set_company_ad_category (one category, from 20261008003250) now goes through it.
-- * super_ads_overview: each category also names its company or client, for the picker.
-- ---------------------------------------------------------------------------

drop index if exists public.ad_categories_company_key;
create index if not exists ad_categories_company_idx on public.ad_categories (ad_account_id, company_id) where company_id is not null;

create function public.set_company_ad_categories(p_account uuid, p_company uuid, p_categories uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid;
  v_ids uuid[] := array(select distinct x from unnest(coalesce(p_categories, '{}')) x where x is not null);
  v_previous uuid[];
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select a.company_id into v_owner from public.ad_accounts a
  where a.id = p_account and a.kind = 'company' and a.archived_at is null for update;
  if v_owner is null or p_company = v_owner or not exists (
    select 1 from public.companies c where c.id = p_company and c.archived_at is null and c.parent_company_id is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if cardinality(v_ids) > 500 then
    raise exception 'invalid_categories' using errcode = '22023';
  end if;

  perform 1 from public.ad_categories k where k.ad_account_id = p_account for update;
  if exists (select 1 from unnest(v_ids) x where not exists (
    select 1 from public.ad_categories k where k.id = x and k.ad_account_id = p_account and k.archived_at is null)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.ad_categories k where k.id = any(v_ids)
             and (k.ads_client_id is not null or (k.company_id is not null and k.company_id <> p_company))) then
    raise exception 'category_in_use' using errcode = '23514';
  end if;

  -- Joins the shared account (one shared account per company, as in merge_ad_account).
  if cardinality(v_ids) > 0 and not exists (
    select 1 from public.ad_account_members m where m.ad_account_id = p_account and m.company_id = p_company) then
    if exists (select 1 from public.ad_account_members m where m.company_id = p_company) then
      raise exception 'already_merged' using errcode = '23514';
    end if;
    insert into public.ad_account_members (ad_account_id, company_id) values (p_account, p_company);
  end if;

  v_previous := array(select k.id from public.ad_categories k
    where k.ad_account_id = p_account and k.company_id = p_company and k.archived_at is null);
  -- Unticked ones become ordinary categories (their campaigns stay in them).
  update public.ad_categories set company_id = null
  where ad_account_id = p_account and company_id = p_company and archived_at is null and not (id = any(v_ids));
  update public.ad_categories set company_id = p_company where id = any(v_ids);
  perform private.auto_categorise_ads(p_account);
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ad_categories_mapped', jsonb_build_object('ad_account_id', p_account, 'company_id', p_company,
    'category_ids', to_jsonb(v_ids), 'previous_category_ids', to_jsonb(v_previous)));
end $$;

-- As in 20261008003250 (same checks and default), then set_company_ad_categories with that one category.
create or replace function public.set_company_ad_category(p_account uuid, p_company uuid, p_category uuid default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text;
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
  if v_target is null then
    insert into public.ad_categories (ad_account_id, name, match_text)
    values (p_account, left(v_name, 60), left(v_name, 60)) returning id into v_target;
  end if;
  perform public.set_company_ad_categories(p_account, p_company, array[v_target]);
end $$;

-- As in 20261008003250, plus company_name / client_name on each category.
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
          'company_name', (select t.name from public.companies t where t.id = k.company_id),
          'ads_client_id', k.ads_client_id,
          'client_name', (select coalesce(cl.company_name, cl.name) from public.ads_clients cl where cl.id = k.ads_client_id),
          'campaigns', (select count(*) from public.ad_campaigns x where x.category_id = k.id))
          order by lower(k.name))
        from public.ad_accounts a join public.ad_categories k on k.ad_account_id = a.id and k.archived_at is null
        where a.company_id = c.id and a.kind = 'company' and a.archived_at is null), '[]'::jsonb)
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c where c.archived_at is null and c.parent_company_id is null
  );
end $$;

revoke all on function public.set_company_ad_categories(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.set_company_ad_categories(uuid, uuid, uuid[]) to authenticated;
