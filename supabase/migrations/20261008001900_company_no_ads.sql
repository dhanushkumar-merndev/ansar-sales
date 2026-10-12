-- ---------------------------------------------------------------------------
-- Companies without their own ads work. Star Growth Hub runs Facebook ads for its client companies from
-- its own ad accounts, so a company like Star Gardens doesn't need the Ads module or the Automation page
-- (Facebook Lead Ads). The "no_ads" feature switches both off for a company — in the database too:
-- nobody there counts as an ads user, and its admins can't manage Meta lead forms. The super admin
-- switches it in Super settings → Companies.
-- ---------------------------------------------------------------------------

alter table public.companies drop constraint companies_features_check;
alter table public.companies add constraint companies_features_check check (features <@ array['projects', 'no_ads']::text[]);

create or replace function public.set_company_feature(p_company_id uuid, p_feature text, p_enabled boolean)
returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_features text[];
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if p_feature is null or p_feature not in ('projects', 'no_ads') then
    raise exception 'invalid_feature' using errcode = '22023';
  end if;
  update public.companies c set features = case
      when coalesce(p_enabled, false) then (select array_agg(distinct f order by f) from unnest(c.features || p_feature) f)
      else array_remove(c.features, p_feature) end
  where c.id = p_company_id
  returning c.features into v_features;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_enabled and p_feature = 'projects' then
    perform private.apply_projects_pipeline(p_company_id);
  end if;
  return v_features;
end $$;

create or replace function private.is_ads_user()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.app_role() in ('admin', 'ads_manager'), false) and not private.company_has('no_ads') $$;

create or replace function private.can_manage_meta(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_super_admin()
    or (private.app_role() = 'admin' and p_company_id is not null and p_company_id = private.current_company_id()
        and not private.company_has('no_ads'));
$$;

update public.companies set features = (select array_agg(distinct f order by f) from unnest(features || array['no_ads']) f)
where normalized_name = 'star gardens';
