-- ---------------------------------------------------------------------------
-- Client portal: the client's leads, list only and read-only. Off by default; the ads team switches it
-- on per client (Ads → client → Client login). The leads are the ones in the client's CRM, so it needs
-- one. A client login has no access to leads under RLS: portal_leads reads them for it, returning
-- contact fields, stage and dates only (no notes, owners or follow-ups).
-- ---------------------------------------------------------------------------

alter table public.ads_clients add column portal_show_leads boolean not null default false;

create or replace function private.ads_client_json(c public.ads_clients)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'company_id', c.company_id, 'lead_id', c.lead_id, 'name', c.name, 'company_name', c.company_name, 'phone', c.phone,
    'email', c.email, 'business', c.business, 'status', c.status, 'notes', c.notes, 'started_at', c.started_at,
    'closed_at', c.closed_at, 'created_at', c.created_at,
    'portal_show_leads', c.portal_show_leads, 'has_crm', c.workspace_company_id is not null)
$$;

-- The ads team: show or hide the client's leads in its portal.
create function public.set_client_portal_leads(p_client uuid, p_on boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_ads_client(p_client);
  if p_on is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_on and not exists (select 1 from public.ads_clients c where c.id = p_client and c.workspace_company_id is not null) then
    raise exception 'no_crm' using errcode = '22023';
  end if;
  update public.ads_clients set portal_show_leads = p_on where id = p_client;
end $$;

-- As before, plus whether the portal shows the client's leads.
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
      'client', jsonb_build_object('id', c.id, 'name', c.name, 'company_name', c.company_name, 'business', c.business, 'status', c.status, 'started_at', c.started_at),
      'agency', (select jsonb_build_object('name', k.name, 'brand_highlight', k.brand_highlight, 'logo_path', k.logo_path)
        from public.companies k where k.id = c.company_id),
      'accounts', coalesce((select jsonb_agg(private.ad_account_json(a, 'client') order by a.archived_at nulls first, a.created_at desc)
        from public.ad_accounts a where a.ads_client_id = c.id), '[]'::jsonb),
      'agency_sources', coalesce((select jsonb_agg(jsonb_build_object('category_id', k.id, 'category_name', k.name,
          'account', private.ad_account_json(a, 'client_category')) order by a.archived_at nulls first, a.created_at desc)
        from public.ad_categories k join public.ad_accounts a on a.id = k.ad_account_id
        where k.ads_client_id = c.id and k.archived_at is null), '[]'::jsonb),
      'show_leads', c.portal_show_leads and c.workspace_company_id is not null)
    from public.ads_clients c where c.id = v_client
  );
end $$;

-- The signed-in client login's leads, newest first: { items, total }.
create function public.portal_leads(p_search text default null, p_limit integer default 20, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ws uuid;
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_digits text;
begin
  select c.workspace_company_id into v_ws
  from public.profiles p
  join public.ads_clients c on c.id = p.ads_client_id and c.portal_show_leads
  where p.id = (select auth.uid()) and p.is_active and p.role = 'client';
  if v_ws is null then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null and char_length(v_term) > 100 then
    raise exception 'search_too_long' using errcode = '22023';
  end if;
  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  return (
    with matched as (
      select l.* from public.leads l
      where l.company_id = v_ws and l.archived_at is null
        and (v_pattern is null or l.name ilike v_pattern or l.company_name ilike v_pattern or l.email ilike v_pattern
             or (v_digits is not null and l.phone_normalized like v_digits))
    )
    select jsonb_build_object(
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', m.id, 'name', m.name, 'company_name', m.company_name, 'phone', m.phone, 'email', m.email,
          'stage', s.name, 'status', m.status, 'source', m.source, 'created_at', m.created_at
        ) order by m.created_at desc, m.id desc)
        from (select * from matched order by created_at desc, id desc limit p_limit offset p_offset) m
        left join public.pipeline_stages s on s.id = m.stage_id), '[]'::jsonb),
      'total', (select count(*) from matched))
  );
end $$;

revoke all on function public.set_client_portal_leads(uuid, boolean), public.portal_leads(text, integer, integer) from public, anon;
grant execute on function public.set_client_portal_leads(uuid, boolean), public.portal_leads(text, integer, integer) to authenticated;
