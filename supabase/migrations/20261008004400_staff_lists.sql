-- ---------------------------------------------------------------------------
-- Staff pickers and the Users list.
-- 1. Lead owner pickers listed every active admin/sales the caller could see. Admins see the staff of
--    every company sharing their books, so other companies' admins showed up (and picking one failed
--    with invalid_owner). list_lead_staff() returns only people who can own a lead in the current
--    company: the same rule private.company_guard enforces.
-- 2. The Users list hides deactivated people unless asked (new p_include_inactive argument goes last).
-- ---------------------------------------------------------------------------

create function public.list_lead_staff()
returns table (id uuid, display_name text, role public.app_role)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_workspace boolean := private.is_workspace(v_company);
begin
  if private.app_role() is null or private.app_role() = 'client' then
    perform private.raise_forbidden();
  end if;
  return query
    select p.id, p.display_name, p.role
    from public.profiles p
    where p.is_active
      and p.role in ('sales', 'admin', 'ads_manager')
      and (p.company_id = v_company
        or (p.id in (select s.user_id from public.sales_user_companies s where s.company_id = v_company)
            and private.sales_member(p.id, v_company))
        or (v_workspace and private.workspace_staff(p.id, v_company)))
    order by p.display_name, p.id
    limit 100;
end $$;

drop function public.admin_list_users(text, public.app_role, integer, integer);

-- Unchanged except: deactivated people only when p_include_inactive.
create function public.admin_list_users(
  p_search text default null,
  p_role public.app_role default null,
  p_limit integer default 20,
  p_offset integer default 0,
  p_include_inactive boolean default false
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
  v_company uuid := private.current_company_id();
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select p.* from public.profiles p
    where p.company_id = v_company
      and p.role <> 'client'
      and (coalesce(p_include_inactive, false) or p.is_active)
      and (p_role is null or p.role = p_role or p_role = any(p.extra_roles))
      and (v_pattern is null or p.username ilike v_pattern or p.display_name ilike v_pattern)
  ), page as (
    select f.*, row_number() over (order by f.is_active desc, lower(f.display_name), f.id) as rn
    from filtered f
    order by rn
    limit p_limit offset p_offset
  )
  select (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', pg.id, 'username', pg.username, 'display_name', pg.display_name, 'role', pg.role,
      'extra_roles', to_jsonb(pg.extra_roles),
      'is_active', pg.is_active, 'created_at', pg.created_at,
      'owned_active_leads', (select count(*) from public.leads l where l.owner_id = pg.id and l.archived_at is null)
    ) order by pg.rn), '[]'::jsonb) from page pg)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

revoke all on function
  public.list_lead_staff(),
  public.admin_list_users(text, public.app_role, integer, integer, boolean)
from public, anon;

grant execute on function
  public.list_lead_staff(),
  public.admin_list_users(text, public.app_role, integer, integer, boolean)
to authenticated;

notify pgrst, 'reload schema';
