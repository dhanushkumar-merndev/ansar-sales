-- ---------------------------------------------------------------------------
-- Ads clients only for the agency. Star Growth Hub turns leads into ads clients and runs their ads;
-- other companies with ads connect their own Facebook and see their own ads, but have no clients.
-- The "ads_agency" feature ("Runs ads for clients", Super settings → Companies) switches on:
--   * "Add as client" on a lead (can_add_ads_client → lead_ads_client / lead_to_ads_client),
--   * Won leads becoming ads clients (lead_won_to_ads_client),
--   * any other new ads client (a guard on ads_clients inserts).
-- On for Star Growth Hub only. Existing clients are untouched. Additive apart from the feature-list
-- constraint, which is swapped for one that also allows "ads_agency" (no data changes).
-- ---------------------------------------------------------------------------

alter table public.companies drop constraint companies_features_check;
alter table public.companies add constraint companies_features_check
  check (features <@ array['projects', 'no_ads', 'client_workspace', 'ads_agency']::text[]);

-- Same as 1900, plus "ads_agency".
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
  if p_feature is null or p_feature not in ('projects', 'no_ads', 'ads_agency') then
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

-- Same as 3700, but only in the agency.
create or replace function private.can_add_ads_client()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select (private.is_ads_user() or (private.is_super_admin() and not private.company_has('no_ads')))
    and private.company_has('ads_agency')
$$;

-- Same as 2400, but only in the agency (elsewhere marking a lead Won simply creates no client).
create or replace function private.lead_won_to_ads_client()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid;
  v_niche text;
begin
  if not exists (select 1 from public.companies c
                 where c.id = new.company_id and c.won_to_ads_client and c.archived_at is null and 'ads_agency' = any(c.features)) then
    return null;
  end if;
  select n.name into v_niche from public.niches n where n.id = new.niche_id;
  -- Only contact details move over, never notes.
  insert into public.ads_clients (company_id, lead_id, name, company_name, phone, email, business, created_by)
  values (new.company_id, new.id, new.name, new.company_name, new.phone, new.email, v_niche,
    (select p.id from public.profiles p where p.id = (select auth.uid())))
  on conflict (lead_id) do nothing
  returning id into v_client;
  if v_client is null then
    return null;
  end if;
  insert into public.lead_activities (lead_id, actor_id, type, body)
  values (new.id, null, 'note', 'Handed over to the ads team as a new ads client.');
  perform private.enqueue_for_ads_team(new.company_id, 'ads_client_new', jsonb_strip_nulls(jsonb_build_object(
    'ads_client_id', v_client, 'client', new.name, 'client_company', new.company_name, 'business', v_niche, 'won_by', private.display_name(new.owner_id))),
    'ads_client_new:' || v_client, (select auth.uid()));
  return null;
end $$;

-- Any new ads client (e.g. created by hand in Ads → Clients) must belong to the agency.
create function private.ads_clients_agency_only()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.companies c where c.id = new.company_id and 'ads_agency' = any(c.features)) then
    perform private.raise_forbidden();
  end if;
  return new;
end $$;

create trigger ads_clients_agency_only before insert on public.ads_clients
  for each row execute function private.ads_clients_agency_only();

update public.companies
set features = (select array_agg(distinct f order by f) from unnest(features || array['ads_agency']) f)
where normalized_name = 'star growth hub' and not ('ads_agency' = any(features));

notify pgrst, 'reload schema';
