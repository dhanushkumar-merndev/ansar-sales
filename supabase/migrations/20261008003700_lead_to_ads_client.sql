-- ---------------------------------------------------------------------------
-- "Add as client" on a lead: hands the lead to the ads team as an ads client without marking it
-- Won (the same contact details and notification as the won-lead handoff). For admins and ads
-- managers of a company with ads (not inside a client's CRM). One client per lead.
-- ---------------------------------------------------------------------------

-- Admins and ads managers of a company with ads; the super admin wherever ads are on.
create function private.can_add_ads_client()
returns boolean
language sql stable security definer set search_path = ''
as $$ select private.is_ads_user() or (private.is_super_admin() and not private.company_has('no_ads')) $$;

-- The lead's ads client, if it has one (deleted ones included, so the button can say so).
create function public.lead_ads_client(p_lead_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_add_ads_client() or not private.can_access_lead(p_lead_id) then
    return null;
  end if;
  return (
    select jsonb_build_object('id', c.id, 'deleted', c.deleted_at is not null)
    from public.ads_clients c
    join public.leads l on l.id = c.lead_id and l.company_id = c.company_id
    where c.lead_id = p_lead_id and c.company_id = private.current_company_id());
end $$;

create function public.lead_to_ads_client(p_lead_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_lead public.leads%rowtype;
  v_existing public.ads_clients%rowtype;
  v_client uuid;
  v_niche text;
begin
  select * into v_lead from public.leads l where l.id = p_lead_id;
  if not found or not private.can_add_ads_client() or not private.can_access_lead(p_lead_id)
     or v_lead.company_id is distinct from private.current_company_id()
     or exists (select 1 from public.companies w where w.id = v_lead.company_id and w.parent_company_id is not null) then
    perform private.raise_forbidden();
  end if;
  if v_lead.archived_at is not null then
    raise exception 'lead_archived' using errcode = '22023';
  end if;

  select * into v_existing from public.ads_clients c where c.lead_id = p_lead_id for update;
  if found then
    if v_existing.deleted_at is not null then
      raise exception 'ads_client_deleted' using errcode = '22023';
    end if;
    return v_existing.id;
  end if;

  select n.name into v_niche from public.niches n where n.id = v_lead.niche_id;
  insert into public.ads_clients (company_id, lead_id, name, company_name, phone, email, business, created_by)
  values (v_lead.company_id, v_lead.id, v_lead.name, v_lead.company_name, v_lead.phone, v_lead.email, v_niche, v_uid)
  on conflict (lead_id) do nothing
  returning id into v_client;
  -- Skipped by ads_clients_not_our_company: the lead is one of our own companies.
  if v_client is null then
    raise exception 'client_is_our_company' using errcode = '22023';
  end if;

  insert into public.lead_activities (lead_id, actor_id, type, body)
  values (v_lead.id, v_uid, 'note', 'Added as an ads client.');
  perform private.enqueue_for_ads_team(v_lead.company_id, 'ads_client_new', jsonb_strip_nulls(jsonb_build_object(
    'ads_client_id', v_client, 'client', v_lead.name, 'client_company', v_lead.company_name, 'business', v_niche,
    'won_by', private.display_name(v_lead.owner_id))),
    'ads_client_new:' || v_client, v_uid);
  return v_client;
end $$;

revoke all on function private.can_add_ads_client() from public, anon;
grant execute on function private.can_add_ads_client() to authenticated;
revoke all on function public.lead_ads_client(uuid), public.lead_to_ads_client(uuid) from public, anon;
grant execute on function public.lead_ads_client(uuid), public.lead_to_ads_client(uuid) to authenticated;
