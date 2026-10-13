-- ---------------------------------------------------------------------------
-- Company names. A lead can carry the company it belongs to (optional); a won lead hands it to its
-- ads client, which the ads team can edit. Ads screens show the company first, the person second.
-- (ads_clients.business is the lead's niche, i.e. its industry, not a company name.)
-- New p_company_name arguments go last, so existing argument positions don't change.
-- ---------------------------------------------------------------------------

alter table public.leads add column company_name text check (company_name is null or char_length(company_name) <= 120);
alter table public.ads_clients add column company_name text check (company_name is null or char_length(company_name) <= 120);

-- Lead functions run as the caller (RLS), so the column needs the same privileges as the others.
grant insert (company_name), update (company_name) on public.leads to authenticated;

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
drop function public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean);
drop function public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean);

create function public.create_lead(
  p_name text,
  p_phone text,
  p_phone_normalized text,
  p_email text default null,
  p_niche_id uuid default null,
  p_new_niche text default null,
  p_stage_id uuid default null,
  p_owner_id uuid default null,
  p_note text default null,
  p_follow_up_at timestamptz default null,
  p_follow_up_task text default null,
  p_allow_duplicate boolean default false,
  p_company_name text default null
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_niche uuid;
  v_lead uuid;
  v_owner uuid;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;

  if not coalesce(p_allow_duplicate, false)
     and (public.check_duplicate_phone(p_phone_normalized) ->> 'duplicate')::boolean then
    raise exception 'duplicate_phone' using errcode = '23505';
  end if;

  v_niche := private.resolve_niche(p_niche_id, p_new_niche);
  v_owner := case when v_role = 'admin' then coalesce(p_owner_id, (select auth.uid())) else (select auth.uid()) end;

  insert into public.leads (name, company_name, phone, phone_normalized, email, niche_id, stage_id, owner_id, created_by)
  values (p_name, left(private.clean_label(p_company_name), 120), p_phone, p_phone_normalized, p_email, v_niche, p_stage_id, v_owner, (select auth.uid()))
  returning id into v_lead;

  if private.clean_label(p_note) is not null then
    insert into public.lead_activities (lead_id, type, body, actor_id)
    values (v_lead, 'note', p_note, (select auth.uid()));
  end if;

  if p_follow_up_at is not null then
    insert into public.follow_ups (lead_id, task, due_at, created_by)
    values (v_lead, coalesce(private.clean_label(p_follow_up_task), 'Follow up'), p_follow_up_at, (select auth.uid()));
  end if;

  return v_lead;
end $$;

create function public.update_lead(
  p_id uuid,
  p_version integer,
  p_name text,
  p_phone text,
  p_phone_normalized text,
  p_email text default null,
  p_niche_id uuid default null,
  p_new_niche text default null,
  p_allow_duplicate boolean default false,
  p_company_name text default null
)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_niche uuid;
  v_version integer;
  v_current_phone text;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select l.phone_normalized into v_current_phone from public.leads l where l.id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_current_phone <> p_phone_normalized and not coalesce(p_allow_duplicate, false)
     and (public.check_duplicate_phone(p_phone_normalized, p_id) ->> 'duplicate')::boolean then
    raise exception 'duplicate_phone' using errcode = '23505';
  end if;

  v_niche := private.resolve_niche(p_niche_id, p_new_niche);

  update public.leads l
    set name = p_name, phone = p_phone, phone_normalized = p_phone_normalized,
        email = p_email, niche_id = v_niche, company_name = left(private.clean_label(p_company_name), 120)
    where l.id = p_id and l.version = p_version
    returning l.version into v_version;
  if v_version is null then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  return v_version;
end $$;

-- Unchanged except that a company change is logged with the other edits.
create or replace function private.leads_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_changes jsonb := '{}'::jsonb;
  v_from public.pipeline_stages%rowtype;
  v_to public.pipeline_stages%rowtype;
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, new.created_by, 'lead_created', jsonb_build_object(
      'status', (select s.name from public.pipeline_stages s where s.id = new.stage_id),
      'stage_id', new.stage_id,
      'owner', private.display_name(new.owner_id),
      'niche', (select n.name from public.niches n where n.id = new.niche_id)
    ));
    return null;
  end if;

  if new.stage_id is distinct from old.stage_id then
    select * into v_from from public.pipeline_stages s where s.id = old.stage_id;
    select * into v_to from public.pipeline_stages s where s.id = new.stage_id;
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'status_changed', jsonb_build_object(
      'from', v_from.name, 'to', v_to.name, 'from_kind', v_from.kind, 'to_kind', v_to.kind,
      'from_stage_id', v_from.id, 'to_stage_id', v_to.id));
  end if;

  if new.owner_id is distinct from old.owner_id then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'assigned', jsonb_build_object(
      'from', private.display_name(old.owner_id),
      'to', private.display_name(new.owner_id)
    ));
    -- Keep pending follow-ups (and therefore reminder recipients) with the current owner.
    update public.follow_ups f set assignee_id = new.owner_id
      where f.lead_id = new.id and f.state = 'pending' and f.assignee_id <> new.owner_id;
  end if;

  if new.name is distinct from old.name then
    v_changes := v_changes || jsonb_build_object('Name', jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.company_name is distinct from old.company_name then
    v_changes := v_changes || jsonb_build_object('Company', jsonb_build_object('from', old.company_name, 'to', new.company_name));
  end if;
  if new.phone is distinct from old.phone then
    v_changes := v_changes || jsonb_build_object('Phone', jsonb_build_object('from', old.phone, 'to', new.phone));
  end if;
  if new.email is distinct from old.email then
    v_changes := v_changes || jsonb_build_object('Email', jsonb_build_object('from', old.email, 'to', new.email));
  end if;
  if new.niche_id is distinct from old.niche_id then
    v_changes := v_changes || jsonb_build_object('Niche', jsonb_build_object(
      'from', (select n.name from public.niches n where n.id = old.niche_id),
      'to', (select n.name from public.niches n where n.id = new.niche_id)));
  end if;
  if v_changes <> '{}'::jsonb then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'lead_updated', jsonb_build_object('changes', v_changes));
  end if;

  if new.archived_at is distinct from old.archived_at then
    insert into public.lead_activities (lead_id, actor_id, type)
    values (new.id, v_uid, case when new.archived_at is null then 'lead_restored' else 'lead_archived' end::public.lead_activity_type);
  end if;
  return null;
end $$;

-- Unchanged except: search covers the company, and each item carries it.
create or replace function public.list_leads(
  p_search text default null,
  p_stage_ids uuid[] default null,
  p_niche_id uuid default null,
  p_owner_id uuid default null,
  p_created_from timestamptz default null,
  p_created_to timestamptz default null,
  p_overdue_only boolean default false,
  p_archived boolean default false,
  p_sort text default 'created_at',
  p_dir text default 'desc',
  p_limit integer default 20,
  p_offset integer default 0,
  p_starred_only boolean default false
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_digits text;
  v_order text;
  v_dir text := lower(coalesce(p_dir, 'desc'));
  v_total bigint;
  v_items jsonb;
  v_pinned bigint;
  v_where text := $w$
    where (case when $9 then l.archived_at is not null else l.archived_at is null end)
      and ($1::text is null or l.name ilike $1 or l.company_name ilike $1 or l.email ilike $1 or ($2::text is not null and l.phone_normalized like $2))
      and ($3::uuid[] is null or l.stage_id = any($3))
      and ($4::uuid is null or l.niche_id = $4)
      and ($5::uuid is null or l.owner_id = $5)
      and ($6::timestamptz is null or l.created_at >= $6)
      and ($7::timestamptz is null or l.created_at < $7)
      and (not $8 or exists (
        select 1 from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending' and f.due_at < now()))
      and (not $12 or exists (
        select 1 from public.lead_stars s
        where s.lead_id = l.id and s.user_id = (select auth.uid())))
  $w$;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_offset' using errcode = '22023';
  end if;
  if v_term is not null and char_length(v_term) > 100 then
    raise exception 'search_too_long' using errcode = '22023';
  end if;
  if v_dir not in ('asc', 'desc') then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  v_order := case p_sort
    when 'created_at' then 'l.created_at'
    when 'updated_at' then 'l.updated_at'
    when 'name' then 'lower(l.name)'
    when 'status' then '(select s.position from public.pipeline_stages s where s.id = l.stage_id)'
    when 'next_follow_up' then 'nf.next_due'
    else null end;
  if v_order is null then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;

  if v_role <> 'admin' then
    -- Sales scope is enforced by RLS; owner filtering and archive views are admin-only.
    p_owner_id := null;
    p_archived := false;
  end if;
  p_starred_only := coalesce(p_starred_only, false);

  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  execute 'select count(*) from public.leads l ' || v_where
    into v_total
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only;

  -- Pinned leads come first in every view (most recently pinned on top).
  execute format($q$
    with page as (
      select l.*, nf.next_due, nf.overdue, st.pinned_at as star_pinned_at, st.lead_id is not null as is_starred,
        row_number() over (order by st.pinned_at desc nulls last, %s %s nulls last, l.id %s) as rn
      from public.leads l
      left join lateral (
        select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
      left join public.lead_stars st on st.lead_id = l.id and st.user_id = (select auth.uid())
      %s
      order by st.pinned_at desc nulls last, %s %s nulls last, l.id %s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'company_name', p.company_name, 'phone', p.phone, 'email', p.email, 'status', p.status, 'stage_id', p.stage_id,
      'source', p.source,
      'niche', jsonb_build_object('id', n.id, 'name', n.name),
      'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name),
      'next_follow_up_at', p.next_due, 'overdue', coalesce(p.overdue, false),
      'created_at', p.created_at, 'updated_at', p.updated_at,
      'archived_at', p.archived_at, 'version', p.version,
      'starred', p.is_starred, 'pinned_at', p.star_pinned_at
    ) order by p.rn), '[]'::jsonb)
    from page p
    join public.niches n on n.id = p.niche_id
    join public.profiles o on o.id = p.owner_id
  $q$, v_order, v_dir, v_dir, v_where, v_order, v_dir, v_dir)
    into v_items
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

-- ---------------------------------------------------------------------------
-- Ads clients
-- ---------------------------------------------------------------------------
create or replace function private.lead_won_to_ads_client()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_client uuid;
  v_niche text;
begin
  if not exists (select 1 from public.companies c where c.id = new.company_id and c.won_to_ads_client and c.archived_at is null) then
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

create or replace function private.ads_client_json(c public.ads_clients)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'company_id', c.company_id, 'lead_id', c.lead_id, 'name', c.name, 'company_name', c.company_name, 'phone', c.phone,
    'email', c.email, 'business', c.business, 'status', c.status, 'notes', c.notes, 'started_at', c.started_at,
    'closed_at', c.closed_at, 'created_at', c.created_at)
$$;

drop function public.create_ads_client(text, text, text, text, text);
drop function public.update_ads_client(uuid, text, text, text, text, text);

create function public.create_ads_client(p_name text, p_phone text default null, p_email text default null,
  p_business text default null, p_notes text default null, p_company_name text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_company uuid := private.current_company_id();
begin
  if not private.is_ads_user() or v_company is null then
    perform private.raise_forbidden();
  end if;
  if private.clean_label(p_name) is null then
    raise exception 'invalid_ads_client' using errcode = '22023';
  end if;
  insert into public.ads_clients (company_id, name, company_name, phone, email, business, notes, created_by)
  values (v_company, left(private.clean_label(p_name), 120), left(private.clean_label(p_company_name), 120), left(nullif(btrim(coalesce(p_phone, '')), ''), 32),
    left(nullif(lower(btrim(coalesce(p_email, ''))), ''), 254), left(private.clean_label(p_business), 120),
    left(nullif(btrim(coalesce(p_notes, '')), ''), 2000), (select auth.uid()))
  returning id into v_id;
  return v_id;
end $$;

create function public.update_ads_client(p_id uuid, p_name text default null, p_phone text default null, p_email text default null,
  p_business text default null, p_notes text default null, p_company_name text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.require_ads_client(p_id);
  update public.ads_clients set
    name = coalesce(left(private.clean_label(p_name), 120), name),
    company_name = case when p_company_name is null then company_name else left(private.clean_label(p_company_name), 120) end,
    phone = case when p_phone is null then phone else left(nullif(btrim(p_phone), ''), 32) end,
    email = case when p_email is null then email else left(nullif(lower(btrim(p_email)), ''), 254) end,
    business = case when p_business is null then business else left(private.clean_label(p_business), 120) end,
    notes = case when p_notes is null then notes else left(nullif(btrim(p_notes), ''), 2000) end
  where id = p_id;
end $$;

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
    where c.company_id = v_company
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
        where k.ads_client_id = c.id and k.archived_at is null), '[]'::jsonb))
    from public.ads_clients c where c.id = v_client
  );
end $$;

create or replace function public.set_ads_client_category(p_client uuid, p_category uuid default null, p_create boolean default false)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.require_ads_client(p_client);
  v_client public.ads_clients%rowtype;
  v_account uuid;
  v_cat public.ad_categories%rowtype;
  v_name text;
  v_id uuid;
begin
  select * into v_client from public.ads_clients c where c.id = p_client for update;
  select a.id into v_account from public.ad_accounts a
  where a.company_id = v_company and a.kind = 'company' and a.archived_at is null;
  if v_account is null then
    raise exception 'no_agency_ad_account' using errcode = '22023';
  end if;
  perform private.require_ad_access(v_account, true);

  if coalesce(p_create, false) then
    v_name := left(coalesce(private.clean_label(v_client.company_name), private.clean_label(v_client.business), private.clean_label(v_client.name)), 60);
    select * into v_cat from public.ad_categories k
    where k.ad_account_id = v_account and k.archived_at is null
      and k.normalized_name = lower(regexp_replace(btrim(v_name), '\s+', ' ', 'g')) for update;
    if found and (v_cat.company_id is not null or (v_cat.ads_client_id is not null and v_cat.ads_client_id <> p_client)) then
      raise exception 'category_taken' using errcode = '23514';
    end if;
    v_id := v_cat.id;
  elsif p_category is not null then
    select * into v_cat from public.ad_categories k where k.id = p_category and k.ad_account_id = v_account and k.archived_at is null for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if v_cat.company_id is not null or (v_cat.ads_client_id is not null and v_cat.ads_client_id <> p_client) then
      raise exception 'category_taken' using errcode = '23514';
    end if;
    v_id := v_cat.id;
  end if;

  update public.ad_categories set ads_client_id = null
  where ad_account_id = v_account and ads_client_id = p_client and id is distinct from v_id;
  if coalesce(p_create, false) and v_id is null then
    insert into public.ad_categories (ad_account_id, name, ads_client_id) values (v_account, v_name, p_client) returning id into v_id;
  elsif v_id is not null then
    update public.ad_categories set ads_client_id = p_client where id = v_id;
  end if;
  perform private.auto_categorise_ads(v_account);
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'ads_client_category', jsonb_build_object('ads_client_id', p_client, 'ad_account_id', v_account, 'category_id', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean, text),
  public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean, text),
  public.create_ads_client(text, text, text, text, text, text),
  public.update_ads_client(uuid, text, text, text, text, text, text)
from public, anon, authenticated;

grant execute on function
  public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean, text),
  public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean, text),
  public.create_ads_client(text, text, text, text, text, text),
  public.update_ads_client(uuid, text, text, text, text, text, text)
to authenticated;
