-- ---------------------------------------------------------------------------
-- Deleting an ads client: soft delete, the super admin's Deleted list, an Excel export of everything,
-- then a permanent delete.
--
-- * delete_ads_client (super admin): the client disappears from every list and page. It is closed,
--   syncing stops, its portal logins are turned off, and its client CRM is archived (nobody can work
--   in it; pending reminders there are skipped). Everything is kept, and restore_ads_client undoes it.
-- * ads_client_export (super admin): the deleted client's data, one sheet at a time, for the Excel file.
--   mark_ads_client_exported records that the file was made.
-- * purge_ads_client (super admin): only after an export made since the deletion. Removes the client,
--   its own ad accounts with their synced history and saved secrets, its portal logins, and its client
--   CRM with every lead, follow-up, timeline entry, Facebook connection and staff login. A category on
--   our own ad account stays (it is our account's), unlinked. Returns the logins whose Auth users the
--   server then deletes.
-- ---------------------------------------------------------------------------

alter table public.ads_clients
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles (id) on delete set null,
  add column exported_at timestamptz;

create index ads_clients_deleted_idx on public.ads_clients (deleted_at desc) where deleted_at is not null;

create or replace function private.require_ads_client(p_client uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid;
begin
  -- A deleted client is gone for everyone; only the super admin's Deleted list reads it.
  select c.company_id into v_company from public.ads_clients c where c.id = p_client and c.deleted_at is null;
  if v_company is null or not (private.is_super_admin() or (private.is_ads_user() and v_company = private.current_company_id())) then
    perform private.raise_forbidden();
  end if;
  return v_company;
end $$;

-- Unchanged except that deleted clients are left out.
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
    where c.company_id = v_company and c.deleted_at is null
      and (p_status is null or (p_status = 'open' and c.status <> 'closed') or c.status = p_status)
      and (v_pattern is null or c.name ilike v_pattern or c.company_name ilike v_pattern or c.business ilike v_pattern or c.phone ilike v_pattern or c.email ilike v_pattern)
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

create function public.delete_ads_client(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_client public.ads_clients%rowtype;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_client from public.ads_clients c where c.id = p_id and c.deleted_at is null for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.ads_clients set deleted_at = now(), deleted_by = (select auth.uid()), exported_at = null,
    status = 'closed', closed_at = coalesce(closed_at, now())
  where id = p_id;
  update public.ad_accounts set sync_paused = true, next_sync_after = null where ads_client_id = p_id;
  update public.profiles set is_active = false where ads_client_id = p_id and role = 'client' and is_active;
  if v_client.workspace_company_id is not null then
    update public.companies set archived_at = coalesce(archived_at, now()) where id = v_client.workspace_company_id;
    update public.reminder_deliveries d set state = 'skipped', last_error = 'The client was deleted.', lease_token = null
    from public.follow_ups f join public.leads l on l.id = f.lead_id
    where f.id = d.follow_up_id and l.company_id = v_client.workspace_company_id and d.state in ('pending', 'processing');
  end if;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_deleted', jsonb_build_object('ads_client_id', p_id, 'name', coalesce(v_client.company_name, v_client.name)));
end $$;

-- Back in the lists, closed, with its CRM open again. Logins stay off and skipped reminders stay skipped.
create function public.restore_ads_client(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_client public.ads_clients%rowtype;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_client from public.ads_clients c where c.id = p_id and c.deleted_at is not null for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  update public.ads_clients set deleted_at = null, deleted_by = null, exported_at = null where id = p_id;
  if v_client.workspace_company_id is not null then
    update public.companies set archived_at = null where id = v_client.workspace_company_id;
  end if;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_restored', jsonb_build_object('ads_client_id', p_id, 'name', coalesce(v_client.company_name, v_client.name)));
end $$;

-- The super admin's Deleted list (every agency), newest first.
create function public.super_deleted_ads_clients()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name, 'company_name', c.company_name, 'business', c.business,
      'agency_name', (select k.name from public.companies k where k.id = c.company_id),
      'deleted_at', c.deleted_at, 'deleted_by', private.display_name(c.deleted_by), 'exported_at', c.exported_at,
      'can_purge', c.exported_at is not null and c.exported_at >= c.deleted_at,
      'crm_leads', (select count(*) from public.leads l where l.company_id = c.workspace_company_id),
      'crm_users', (select count(*) from public.profiles p where p.company_id = c.workspace_company_id),
      'ad_accounts', (select count(*) from public.ad_accounts a where a.ads_client_id = c.id),
      'logins', (select count(*) from public.profiles p where p.ads_client_id = c.id)
    ) order by c.deleted_at desc, c.id), '[]'::jsonb)
    from public.ads_clients c where c.deleted_at is not null
  );
end $$;

-- One sheet of a deleted client's export, p_limit rows from p_offset in a fixed order.
create function public.ads_client_export(p_id uuid, p_section text, p_offset integer default 0, p_limit integer default 2000)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_client public.ads_clients%rowtype;
  v_ws uuid;
  v_out jsonb;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 or p_offset is null or p_offset < 0 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  select * into v_client from public.ads_clients c where c.id = p_id and c.deleted_at is not null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_ws := v_client.workspace_company_id;

  if p_section = 'client' then
    v_out := jsonb_build_array(jsonb_build_object(
      'company_name', v_client.company_name, 'contact', v_client.name, 'industry', v_client.business,
      'phone', v_client.phone, 'email', v_client.email, 'status', v_client.status, 'notes', v_client.notes,
      'agency', (select k.name from public.companies k where k.id = v_client.company_id),
      'crm', (select k.name from public.companies k where k.id = v_ws),
      'started_at', v_client.started_at, 'closed_at', v_client.closed_at, 'created_at', v_client.created_at,
      'deleted_at', v_client.deleted_at, 'deleted_by', private.display_name(v_client.deleted_by)));
  elsif p_section = 'logins' then
    select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) into v_out from (
      select jsonb_build_object('kind', 'Portal login', 'username', p.username, 'name', p.display_name, 'role', p.role,
          'extra_roles', array_to_string(p.extra_roles::text[], ', '), 'active', p.is_active, 'created_at', p.created_at) as j,
        row_number() over (order by (p.company_id is not distinct from v_ws), p.created_at, p.id) as k
      from public.profiles p where p.ads_client_id = p_id or (v_ws is not null and p.company_id = v_ws)
      order by k limit p_limit offset p_offset) t;
    -- CRM staff are labelled as such.
    v_out := (select coalesce(jsonb_agg(case when x.j ->> 'role' = 'client' then x.j else x.j || '{"kind": "CRM user"}' end), '[]'::jsonb)
              from jsonb_array_elements(v_out) x(j));
  elsif p_section = 'ad_accounts' then
    select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) into v_out from (
      select jsonb_build_object('source', case when a.ads_client_id = p_id then 'Client''s own account' else 'Our account · ' || k.name end,
          'act_id', a.act_id, 'name', a.name, 'currency', a.currency, 'status', a.status,
          'created_at', a.created_at, 'last_synced_at', a.last_synced_at, 'disconnected_at', a.archived_at) as j,
        row_number() over (order by (a.ads_client_id = p_id) desc, a.created_at, a.id) as k
      from public.ad_accounts a
      left join public.ad_categories k on k.ad_account_id = a.id and k.ads_client_id = p_id
      where a.ads_client_id = p_id or k.id is not null
      order by k limit p_limit offset p_offset) t;
  elsif p_section in ('campaigns', 'daily') then
    with camps as (
      select c.*, case when a.ads_client_id = p_id then 'Client''s own account' else 'Our account · ' || k.name end as source
      from public.ad_campaigns c
      join public.ad_accounts a on a.id = c.ad_account_id
      left join public.ad_categories k on k.id = c.category_id and k.ads_client_id = p_id
      where a.ads_client_id = p_id or k.id is not null
    )
    select case when p_section = 'campaigns' then (
      select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) from (
        select jsonb_build_object('source', c.source, 'campaign_id', c.meta_id, 'name', c.name, 'objective', c.objective,
            'status', c.effective_status, 'created_at', c.created_time,
            'spend', coalesce(sum(d.spend), 0), 'impressions', coalesce(sum(d.impressions), 0), 'clicks', coalesce(sum(d.clicks), 0),
            'link_clicks', coalesce(sum(d.link_clicks), 0), 'leads', coalesce(sum(d.leads), 0), 'conversions', coalesce(sum(d.conversions), 0),
            'first_day', min(d.date), 'last_day', max(d.date)) as j,
          row_number() over (order by c.source, c.created_time nulls last, c.id) as k
        from camps c left join public.ad_campaign_daily d on d.campaign_id = c.id
        group by c.id, c.source, c.meta_id, c.name, c.objective, c.effective_status, c.created_time
        order by k limit p_limit offset p_offset) t)
    else (
      select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) from (
        select jsonb_build_object('date', d.date, 'source', c.source, 'campaign', c.name, 'spend', d.spend, 'impressions', d.impressions,
            'reach', d.reach, 'clicks', d.clicks, 'link_clicks', d.link_clicks, 'leads', d.leads, 'conversions', d.conversions) as j,
          row_number() over (order by d.date, c.name, d.campaign_id) as k
        from camps c join public.ad_campaign_daily d on d.campaign_id = c.id
        order by k limit p_limit offset p_offset) t) end
    into v_out;
  elsif p_section = 'leads' then
    select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) into v_out from (
      select jsonb_build_object('name', l.name, 'company', l.company_name, 'phone', l.phone, 'email', l.email,
          'niche', (select n.name from public.niches n where n.id = l.niche_id),
          'stage', (select s.name from public.pipeline_stages s where s.id = l.stage_id), 'result', l.status,
          'owner', private.display_name(l.owner_id), 'source', l.source, 'created_at', l.created_at,
          'created_by', private.display_name(l.created_by), 'archived_at', l.archived_at) as j,
        row_number() over (order by l.created_at, l.id) as k
      from public.leads l where v_ws is not null and l.company_id = v_ws
      order by k limit p_limit offset p_offset) t;
  elsif p_section = 'timeline' then
    select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) into v_out from (
      select jsonb_build_object('lead', l.name, 'phone', l.phone, 'at', a.created_at, 'type', a.type,
          'by', coalesce(private.display_name(a.actor_id), 'CRM'), 'text', a.body,
          'from', coalesce(a.meta ->> 'from_name', a.meta ->> 'from'), 'to', coalesce(a.meta ->> 'to_name', a.meta ->> 'to')) as j,
        row_number() over (order by l.created_at, l.id, a.created_at, a.id) as k
      from public.lead_activities a join public.leads l on l.id = a.lead_id
      where v_ws is not null and l.company_id = v_ws
      order by k limit p_limit offset p_offset) t;
  elsif p_section = 'follow_ups' then
    select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) into v_out from (
      select jsonb_build_object('lead', l.name, 'phone', l.phone, 'task', f.task, 'due_at', f.due_at, 'state', f.state,
          'assignee', private.display_name(f.assignee_id), 'outcome', f.outcome, 'created_at', f.created_at,
          'completed_at', f.completed_at, 'cancelled_at', f.cancelled_at) as j,
        row_number() over (order by f.due_at, f.id) as k
      from public.follow_ups f join public.leads l on l.id = f.lead_id
      where v_ws is not null and l.company_id = v_ws
      order by k limit p_limit offset p_offset) t;
  elsif p_section = 'facebook' then
    select coalesce(jsonb_agg(t.j order by t.k), '[]'::jsonb) into v_out from (
      select jsonb_build_object('at', e.created_at, 'form', e.form_name, 'campaign', e.campaign_name, 'ad', e.ad_name,
          'state', e.state, 'error', e.error, 'lead', l.name) as j,
        row_number() over (order by e.created_at, e.id) as k
      from public.meta_lead_events e left join public.leads l on l.id = e.lead_id
      where v_ws is not null and (e.company_id = v_ws or l.company_id = v_ws)
      order by k limit p_limit offset p_offset) t;
  else
    raise exception 'invalid_section' using errcode = '22023';
  end if;
  return v_out;
end $$;

-- The Excel file was made: a permanent delete is allowed from now on.
create function public.mark_ads_client_exported(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  update public.ads_clients set exported_at = clock_timestamp() where id = p_id and deleted_at is not null;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_exported', jsonb_build_object('ads_client_id', p_id));
end $$;

-- Permanent. Returns the ids of the logins removed, whose Auth users the server deletes next.
create function public.purge_ads_client(p_id uuid)
returns uuid[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_client public.ads_clients%rowtype;
  v_ws uuid;
  v_group uuid;
  v_users uuid[];
  v_leads uuid[];
  v_counts jsonb;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select * into v_client from public.ads_clients c where c.id = p_id and c.deleted_at is not null for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_client.exported_at is null or v_client.exported_at < v_client.deleted_at then
    raise exception 'export_required' using errcode = '22023';
  end if;
  v_ws := v_client.workspace_company_id;

  -- A client CRM only uses leads; anything else in it (files, finance, projects) is not ours to wipe here.
  if v_ws is not null and (
    exists (select 1 from public.library_files x where x.company_id = v_ws)
    or exists (select 1 from public.capital_entries x where x.company_id = v_ws)
    or exists (select 1 from public.expenses x where x.company_id = v_ws)
    or exists (select 1 from public.projects x where x.company_id = v_ws)
    or exists (select 1 from public.site_visits x where x.company_id = v_ws)) then
    raise exception 'crm_has_other_data' using errcode = '22023';
  end if;

  select coalesce(array_agg(p.id), '{}') into v_users from public.profiles p
  where p.ads_client_id = p_id or (v_ws is not null and p.company_id = v_ws);
  select coalesce(array_agg(l.id), '{}') into v_leads from public.leads l where v_ws is not null and l.company_id = v_ws;
  v_counts := jsonb_build_object('leads', cardinality(v_leads), 'logins', cardinality(v_users),
    'ad_accounts', (select count(*) from public.ad_accounts a where a.ads_client_id = p_id));

  -- The client CRM: leads with everything hanging off them, then the CRM's own lists.
  if v_ws is not null then
    delete from public.share_events where lead_id = any(v_leads);
    delete from public.lead_shares where lead_id = any(v_leads);
    delete from public.lead_activities where lead_id = any(v_leads);
    delete from public.follow_ups where lead_id = any(v_leads);
    delete from public.leads where id = any(v_leads);
    update public.niches set merged_into_id = null where company_id = v_ws;
    delete from public.niches where company_id = v_ws;
    delete from public.pipeline_stages where company_id = v_ws;
    update public.library_folders set parent_id = null where company_id = v_ws;
    delete from public.library_folders where company_id = v_ws;
    delete from vault.secrets where id in (
      select m.app_secret_id from public.meta_integrations m where m.company_id = v_ws
      union all select m.access_token_id from public.meta_integrations m where m.company_id = v_ws);
  end if;

  -- The client's own ad accounts (their synced history goes with them) and saved secrets.
  delete from vault.secrets where id in (
    select a.app_secret_id from public.ad_accounts a where a.ads_client_id = p_id and a.app_secret_id is not null
    union all select a.access_token_id from public.ad_accounts a where a.ads_client_id = p_id and a.access_token_id is not null);
  delete from public.ad_accounts where ads_client_id = p_id;
  -- Our own account's category stays with its campaigns, no longer linked to anyone.
  update public.ad_categories set ads_client_id = null where ads_client_id = p_id;

  -- The logins. The audit log keeps its entries, with the removed person's name instead of a link.
  update public.admin_audit_log set meta = meta || jsonb_build_object('removed_user', private.display_name(target_user_id)), target_user_id = null
  where target_user_id = any(v_users);
  update public.admin_audit_log set meta = meta || jsonb_build_object('removed_actor', private.display_name(actor_id)), actor_id = null
  where actor_id = any(v_users);
  update public.ads_clients set workspace_company_id = null where id = p_id;
  delete from public.profiles where id = any(v_users);

  if v_ws is not null then
    select c.finance_group_id into v_group from public.companies c where c.id = v_ws;
    delete from public.companies where id = v_ws;
    delete from public.finance_groups g where g.id = v_group and not exists (select 1 from public.companies c where c.finance_group_id = g.id);
  end if;
  delete from public.ads_clients where id = p_id;

  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_purged', jsonb_build_object('ads_client_id', p_id,
    'name', coalesce(v_client.company_name, v_client.name)) || v_counts);
  return v_users;
end $$;

revoke all on function
  public.delete_ads_client(uuid), public.restore_ads_client(uuid), public.super_deleted_ads_clients(),
  public.ads_client_export(uuid, text, integer, integer), public.mark_ads_client_exported(uuid), public.purge_ads_client(uuid)
from public, anon, authenticated;
grant execute on function
  public.delete_ads_client(uuid), public.restore_ads_client(uuid), public.super_deleted_ads_clients(),
  public.ads_client_export(uuid, text, integer, integer), public.mark_ads_client_exported(uuid), public.purge_ads_client(uuid)
to authenticated;
