-- Company admins manage their own company's Facebook Lead Ads (Automation page);
-- the super admin still manages every company's from Super settings.

create function private.can_manage_meta(p_company_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_super_admin()
    or (private.app_role() = 'admin' and p_company_id is not null and p_company_id = private.current_company_id());
$$;

revoke all on function private.can_manage_meta(uuid) from public, anon, authenticated;

create or replace function public.save_meta_integration(
  p_company_id uuid, p_app_id text, p_page_id text, p_app_secret text default null, p_access_token text default null
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.meta_integrations%rowtype;
  v_secret text := nullif(btrim(coalesce(p_app_secret, '')), '');
  v_token text := nullif(btrim(coalesce(p_access_token, '')), '');
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.archived_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if (v_secret is not null and char_length(v_secret) > 200) or (v_token is not null and char_length(v_token) > 1000) then
    raise exception 'invalid_meta_settings' using errcode = '22023';
  end if;
  select * into v_row from public.meta_integrations m where m.company_id = p_company_id for update;
  if not found then
    if v_secret is null or v_token is null then
      raise exception 'meta_secrets_required' using errcode = '22023';
    end if;
    insert into public.meta_integrations (company_id, app_id, page_id, app_secret_id, access_token_id)
    values (p_company_id, btrim(p_app_id), btrim(p_page_id),
      vault.create_secret(v_secret, 'meta_app_secret:' || p_company_id, 'Meta app secret'),
      vault.create_secret(v_token, 'meta_access_token:' || p_company_id, 'Meta system user token'));
  else
    if v_secret is not null then
      perform vault.update_secret(v_row.app_secret_id, v_secret);
    end if;
    if v_token is not null then
      perform vault.update_secret(v_row.access_token_id, v_token);
    end if;
    update public.meta_integrations set app_id = btrim(p_app_id), page_id = btrim(p_page_id), status = 'unverified', last_error = null
    where company_id = p_company_id;
  end if;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'meta_integration_saved', jsonb_build_object('company_id', p_company_id));
exception when check_violation then
  raise exception 'invalid_meta_settings' using errcode = '22023';
end $$;

create or replace function public.delete_meta_integration(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_row public.meta_integrations%rowtype;
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  delete from public.meta_integrations where company_id = p_company_id returning * into v_row;
  if found then
    delete from vault.secrets where id in (v_row.app_secret_id, v_row.access_token_id);
    insert into public.admin_audit_log (actor_id, action, meta)
    values ((select auth.uid()), 'meta_integration_removed', jsonb_build_object('company_id', p_company_id));
  end if;
end $$;

create or replace function public.set_meta_routing(p_company_id uuid, p_user_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  if exists (select 1 from unnest(coalesce(p_user_ids, '{}')) x where not exists (
    select 1 from public.profiles p where p.id = x and p.company_id = p_company_id and p.is_active and p.role in ('sales', 'admin'))) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  delete from public.meta_lead_routing r where r.company_id = p_company_id and not (r.user_id = any(coalesce(p_user_ids, '{}')));
  insert into public.meta_lead_routing (company_id, user_id)
  select p_company_id, x from unnest(coalesce(p_user_ids, '{}')) x
  on conflict do nothing;
end $$;

-- Super admin: every company. Company admin: only their own company.
create or replace function public.super_meta_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (private.is_super_admin() or private.app_role() = 'admin') then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', c.id, 'company_name', c.name,
      'integration', (select jsonb_build_object('app_id', m.app_id, 'page_id', m.page_id, 'page_name', m.page_name,
          'verify_token', m.verify_token, 'status', m.status, 'last_checked_at', m.last_checked_at,
          'last_event_at', m.last_event_at, 'last_error', m.last_error)
        from public.meta_integrations m where m.company_id = c.id),
      'routing', coalesce((select jsonb_agg(r.user_id) from public.meta_lead_routing r where r.company_id = c.id), '[]'::jsonb),
      'candidates', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'display_name', p.display_name, 'role', p.role) order by p.role desc, lower(p.display_name))
        from public.profiles p where p.company_id = c.id and p.is_active and p.role in ('sales', 'admin')), '[]'::jsonb),
      'leads_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'created' and e.created_at > now() - interval '7 days'),
      'failed_7d', (select count(*) from public.meta_lead_events e where e.company_id = c.id and e.state = 'failed' and e.created_at > now() - interval '7 days')
    ) order by c.created_at, c.id), '[]'::jsonb)
    from public.companies c
    where c.archived_at is null and private.can_manage_meta(c.id)
  );
end $$;

create or replace function public.super_meta_events(p_company_id uuid, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_manage_meta(p_company_id) then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'leadgen_id', e.leadgen_id, 'form_name', e.form_name, 'ad_name', e.ad_name,
      'state', e.state, 'error', e.error, 'lead_id', e.lead_id, 'lead_name', l.name, 'owner', private.display_name(l.owner_id),
      'created_at', e.created_at) order by e.created_at desc, e.id), '[]'::jsonb)
    from (select * from public.meta_lead_events x where x.company_id = p_company_id
          order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 50), 1), 100)) e
    left join public.leads l on l.id = e.lead_id
  );
end $$;
