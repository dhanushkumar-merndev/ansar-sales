-- Lead source as a pick list, like Niche: Website, Referral, Instagram, Walk-in, … per company.
--
-- * lead_sources: the company's saved sources (unique by normalized name). Read by lead users of the company;
--   written only through private.resolve_lead_source (when a lead is saved or imported with a new name).
-- * leads.source_id: optional. leads.source ('manual' / 'facebook') stays: Facebook leads keep showing "Facebook".
-- * create_lead / update_lead (from 20261008002400) + p_source_id / p_new_source; update_lead changes the source
--   only when p_set_source is true, so an older app version can't clear it.
-- * import_leads (from 20261008003300): a row's 'source_id' / 'new_source'.
-- * leads_after_write (from 20261008004300): logs source changes and the source on creation.
-- * lead_list_page / list_leads / lead_range_summary (from 20261008005600) + p_source (a source id or 'facebook');
--   list_leads items gain source_name.
-- * export_leads (from 20261008003600) + source_name.

create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  archived_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint lead_sources_company_name_key unique (company_id, normalized_name)
);

alter table public.lead_sources enable row level security;
create policy lead_sources_select on public.lead_sources for select to authenticated
  using ((select private.is_lead_user()) and company_id = (select private.current_company_id()));
revoke all on public.lead_sources from anon, authenticated;
grant select on public.lead_sources to authenticated;

alter table public.leads add column source_id uuid references public.lead_sources (id) on delete set null;
create index leads_source_idx on public.leads (source_id) where source_id is not null;
grant insert (source_id), update (source_id) on public.leads to authenticated;

-- A lead's source must belong to the lead's company.
create function private.leads_source_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.source_id is not null and (tg_op = 'INSERT' or new.source_id is distinct from old.source_id) and not exists (
    select 1 from public.lead_sources s where s.id = new.source_id and s.company_id = new.company_id
  ) then
    raise exception 'source_not_found' using errcode = 'P0002';
  end if;
  return new;
end $$;

create trigger leads_source_guard before insert or update of source_id on public.leads
  for each row execute function private.leads_source_guard();

-- The source to store: an existing one by id, a new name (created once per company, case-insensitively), or none.
create function private.resolve_lead_source(p_source_id uuid, p_new_source text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_label text := private.clean_label(p_new_source);
  v_id uuid;
  v_archived timestamptz;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if p_source_id is null then
    if v_label is null then
      return null;
    end if;
    if char_length(v_label) > 40 then
      raise exception 'source_too_long' using errcode = '22023';
    end if;
    insert into public.lead_sources (company_id, name, created_by) values (v_company, v_label, (select auth.uid()))
      on conflict (company_id, normalized_name) do nothing
      returning id into v_id;
    if v_id is not null then
      return v_id;
    end if;
    select s.id into p_source_id from public.lead_sources s
      where s.company_id = v_company and s.normalized_name = lower(regexp_replace(btrim(v_label), '\s+', ' ', 'g'));
  end if;
  select s.id, s.archived_at into v_id, v_archived from public.lead_sources s
    where s.id = p_source_id and s.company_id = v_company;
  if v_id is null then
    raise exception 'source_not_found' using errcode = 'P0002';
  end if;
  if v_archived is not null then
    raise exception 'source_archived' using errcode = '22023';
  end if;
  return v_id;
end $$;

revoke all on function private.resolve_lead_source(uuid, text), private.leads_source_guard() from public, anon;
grant execute on function private.resolve_lead_source(uuid, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.lead_sources;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Saving leads: + source
-- ---------------------------------------------------------------------------
drop function public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean, text);
drop function public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean, text);

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
  p_company_name text default null,
  p_source_id uuid default null,
  p_new_source text default null
)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_niche uuid;
  v_lead uuid;
  v_owner uuid;
  v_source uuid;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;

  if not coalesce(p_allow_duplicate, false)
     and (public.check_duplicate_phone(p_phone_normalized) ->> 'duplicate')::boolean then
    raise exception 'duplicate_phone' using errcode = '23505';
  end if;

  v_niche := private.resolve_niche(p_niche_id, p_new_niche);
  v_source := private.resolve_lead_source(p_source_id, p_new_source);
  v_owner := case when v_role = 'admin' then coalesce(p_owner_id, (select auth.uid())) else (select auth.uid()) end;

  insert into public.leads (name, company_name, phone, phone_normalized, email, niche_id, stage_id, owner_id, created_by, source_id)
  values (p_name, left(private.clean_label(p_company_name), 120), p_phone, p_phone_normalized, p_email, v_niche, p_stage_id, v_owner, (select auth.uid()), v_source)
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
  p_company_name text default null,
  p_set_source boolean default false,
  p_source_id uuid default null,
  p_new_source text default null
)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_niche uuid;
  v_source uuid;
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
  if coalesce(p_set_source, false) then
    v_source := private.resolve_lead_source(p_source_id, p_new_source);
  end if;

  update public.leads l
    set name = p_name, phone = p_phone, phone_normalized = p_phone_normalized,
        email = p_email, niche_id = v_niche, company_name = left(private.clean_label(p_company_name), 120),
        source_id = case when coalesce(p_set_source, false) then v_source else l.source_id end
    where l.id = p_id and l.version = p_version
    returning l.version into v_version;
  if v_version is null then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  return v_version;
end $$;

revoke all on function
  public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean, text, uuid, text),
  public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean, text, boolean, uuid, text)
from public, anon, authenticated;
grant execute on function
  public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean, text, uuid, text),
  public.update_lead(uuid, integer, text, text, text, text, uuid, text, boolean, text, boolean, uuid, text)
to authenticated;

-- Unchanged except a row's source.
create or replace function public.import_leads(p_rows jsonb, p_allow_duplicates boolean default false)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_row jsonb;
  v_i integer := 0;
  v_id uuid;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;
  perform set_config('crm.lead_import', 'on', true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    begin
      v_id := public.create_lead(
        p_name => v_row ->> 'name',
        p_phone => v_row ->> 'phone',
        p_phone_normalized => v_row ->> 'phone_normalized',
        p_email => nullif(v_row ->> 'email', ''),
        p_niche_id => nullif(v_row ->> 'niche_id', '')::uuid,
        p_new_niche => nullif(v_row ->> 'new_niche', ''),
        p_stage_id => nullif(v_row ->> 'stage_id', '')::uuid,
        p_owner_id => nullif(v_row ->> 'owner_id', '')::uuid,
        p_note => nullif(v_row ->> 'note', ''),
        p_allow_duplicate => coalesce(p_allow_duplicates, false),
        p_company_name => nullif(v_row ->> 'company_name', ''),
        p_source_id => nullif(v_row ->> 'source_id', '')::uuid,
        p_new_source => nullif(v_row ->> 'new_source', ''));
      v_out := v_out || jsonb_build_array(jsonb_build_object('index', v_i, 'id', v_id));
    exception when others then
      -- Only our own error codes reach the screen; anything else is reported generically.
      v_out := v_out || jsonb_build_array(jsonb_build_object('index', v_i, 'error',
        case when sqlerrm ~ '^[a-z_]{3,40}$' then sqlerrm else 'invalid_row' end));
    end;
    v_i := v_i + 1;
  end loop;
  perform set_config('crm.lead_import', 'off', true);
  perform private.notify_lead_import();
  return v_out;
end $$;

-- Unchanged except the source on creation and source changes in the edit history.
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
      'niche', (select n.name from public.niches n where n.id = new.niche_id),
      'source', (select s.name from public.lead_sources s where s.id = new.source_id)
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
  if new.source_id is distinct from old.source_id then
    v_changes := v_changes || jsonb_build_object('Source', jsonb_build_object(
      'from', (select s.name from public.lead_sources s where s.id = old.source_id),
      'to', (select s.name from public.lead_sources s where s.id = new.source_id)));
  end if;
  if new.temperature is distinct from old.temperature then
    v_changes := v_changes || jsonb_build_object('Temperature', jsonb_build_object(
      'from', initcap(old.temperature::text), 'to', initcap(new.temperature::text)));
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

-- Unchanged except source_name.
create or replace function public.export_leads(
  p_only_new boolean default false,
  p_after_created timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 1000,
  p_created_from timestamptz default null,
  p_created_before timestamptz default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if private.app_role() is distinct from 'admin' then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 or (p_after_created is null) <> (p_after_id is null) then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'company_name', l.company_name, 'phone', l.phone, 'email', l.email,
      'niche', n.name, 'stage', s.name, 'status', l.status, 'owner', o.display_name, 'source', l.source, 'source_name', ls.name,
      'created_at', l.created_at, 'next_follow_up_at', nf.next_due
    ) order by l.created_at, l.id)
    from (
      select x.* from public.leads x
      where x.archived_at is null
        and (p_after_created is null or (x.created_at, x.id) > (p_after_created, p_after_id))
        and (p_created_from is null or x.created_at >= p_created_from)
        and (p_created_before is null or x.created_at < p_created_before)
        and (not coalesce(p_only_new, false) or not exists (
          select 1 from public.lead_exports e where e.user_id = (select auth.uid()) and e.lead_id = x.id))
      order by x.created_at, x.id
      limit p_limit
    ) l
    left join public.niches n on n.id = l.niche_id
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.profiles o on o.id = l.owner_id
    left join public.lead_sources ls on ls.id = l.source_id
    left join lateral (
      select min(f.due_at) as next_due from public.follow_ups f where f.lead_id = l.id and f.state = 'pending'
    ) nf on true
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Lists: + p_source (from 20261008005600)
-- ---------------------------------------------------------------------------
drop function public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature, uuid);
drop function public.lead_range_summary(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer);
drop function private.lead_list_page(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, boolean);

create function private.lead_list_page(
  p_search text,
  p_stage_ids uuid[],
  p_niche_id uuid,
  p_owner_id uuid,
  p_created_from timestamptz,
  p_created_to timestamptz,
  p_overdue_only boolean,
  p_archived boolean,
  p_sort text,
  p_dir text,
  p_starred_only boolean,
  p_temperature public.lead_temperature,
  p_starred_by uuid,
  p_limit integer,
  p_offset integer,
  p_with_total boolean,
  p_source text
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_uid uuid := (select auth.uid());
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_digits text;
  v_order text;
  v_sort_join text := '';
  v_dir text := lower(coalesce(p_dir, 'desc'));
  v_viewer uuid;
  v_other boolean;
  v_new_stage uuid;
  v_bucket text := '0';
  v_pin_key text := 'm.pinned_at';
  v_total bigint;
  v_rows jsonb;
  v_source text := nullif(btrim(p_source), '');
  v_source_id uuid;
  v_facebook boolean := false;
  v_marks text := 'with marks as materialized (select * from private.lead_marks($14)) ';
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
        select 1 from marks mk
        where mk.lead_id = l.id and (mk.starred or ($15 and mk.pinned_at is not null))))
      and ($13::public.lead_temperature is null or l.temperature = $13)
      and ($16::uuid is null or l.source_id = $16)
      and (not $17 or l.source = 'facebook')
  $w$;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_offset' using errcode = '22023';
  end if;
  -- Source filter: a lead_sources id, or 'facebook' (leads from Facebook lead forms).
  if v_source = 'facebook' then
    v_facebook := true;
  elsif v_source is not null then
    if v_source !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_source' using errcode = '22023';
    end if;
    v_source_id := v_source::uuid;
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
    when 'status' then 'ps.position'
    when 'next_follow_up' then 'nf.next_due'
    else null end;
  if v_order is null then
    raise exception 'invalid_sort' using errcode = '22023';
  end if;
  if p_sort = 'status' then
    v_sort_join := 'left join public.pipeline_stages ps on ps.id = l.stage_id';
  elsif p_sort = 'next_follow_up' then
    v_sort_join := $j$
      left join lateral (
        select min(f.due_at) as next_due
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
    $j$;
  end if;

  if v_role <> 'admin' then
    -- Sales scope is enforced by RLS; owner filtering, archive views and other people's stars are admin-only.
    p_owner_id := null;
    p_archived := false;
    p_starred_by := null;
  end if;
  p_starred_only := coalesce(p_starred_only, false);
  v_viewer := coalesce(p_starred_by, v_uid);
  v_other := v_viewer is distinct from v_uid;
  -- Checked here too: the marks CTE only runs when a lead row needs it.
  if v_other and not exists (select 1 from public.list_lead_staff() s where s.id = v_viewer) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Default sort: leads still in the first open stage ("New") first, newest first; then pins; then the rest.
  if p_sort = 'created_at' and v_dir = 'desc' then
    select s.id into v_new_stage from public.pipeline_stages s
      where s.company_id = private.current_company_id() and s.archived_at is null and s.kind = 'open'
      order by s.position, s.id limit 1;
    if v_new_stage is not null then
      v_bucket := format('case when l.stage_id = %L::uuid then 0 else 1 end', v_new_stage);
      v_pin_key := format('case when l.stage_id = %L::uuid then null else m.pinned_at end', v_new_stage);
    end if;
  end if;

  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
    v_digits := regexp_replace(v_term, '\D', '', 'g');
    v_digits := case when char_length(v_digits) >= 3 then '%' || v_digits || '%' end;
  end if;

  if coalesce(p_with_total, false) then
    execute v_marks || 'select count(*) from public.leads l ' || v_where
      into v_total
      using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
            coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature,
            v_viewer, v_other, v_source_id, v_facebook;
  end if;

  execute v_marks || format($q$
    , ids as (
      select l.id, m.pinned_at as star_pinned_at, coalesce(m.starred, false) as is_starred,
             %5$s as bucket, %6$s as pin_key, %1$s as sort_key
      from public.leads l
      %2$s
      left join marks m on m.lead_id = l.id
      %3$s
      order by 4, 5 desc nulls last, 6 %4$s nulls last, l.id %4$s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', ids.id, 'starred', ids.is_starred, 'pinned_at', ids.star_pinned_at)
      order by ids.bucket, ids.pin_key desc nulls last, ids.sort_key %4$s nulls last, ids.id %4$s), '[]'::jsonb)
    from ids
  $q$, v_order, v_sort_join, v_where, v_dir, v_bucket, v_pin_key)
    into v_rows
    using v_pattern, v_digits, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
          coalesce(p_overdue_only, false), coalesce(p_archived, false), p_limit, p_offset, p_starred_only, p_temperature,
          v_viewer, v_other, v_source_id, v_facebook;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end $$;

create function public.list_leads(
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
  p_starred_only boolean default false,
  p_temperature public.lead_temperature default null,
  p_starred_by uuid default null,
  p_source text default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_page jsonb;
  v_items jsonb;
  v_pinned bigint;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;

  v_page := private.lead_list_page(p_search, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
    p_overdue_only, p_archived, p_sort, p_dir, p_starred_only, p_temperature, p_starred_by, p_limit, p_offset, true, p_source);

  -- Next follow-up, niche and owner only for the page's <= 100 rows.
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'company_name', l.company_name, 'phone', l.phone, 'email', l.email, 'status', l.status, 'stage_id', l.stage_id,
      'source', l.source, 'source_name', ls.name, 'temperature', l.temperature,
      'niche', jsonb_build_object('id', n.id, 'name', n.name),
      'owner', jsonb_build_object('id', o.id, 'display_name', o.display_name),
      'next_follow_up_at', nf.next_due, 'overdue', coalesce(nf.overdue, false),
      'created_at', l.created_at, 'updated_at', l.updated_at,
      'archived_at', l.archived_at, 'version', l.version,
      'starred', r.value -> 'starred', 'pinned_at', r.value -> 'pinned_at'
    ) order by r.ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_page -> 'rows') with ordinality as r(value, ord)
    join public.leads l on l.id = (r.value ->> 'id')::uuid
    left join lateral (
      select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
      from public.follow_ups f
      where f.lead_id = l.id and f.state = 'pending'
    ) nf on true
    join public.niches n on n.id = l.niche_id
    join public.profiles o on o.id = l.owner_id
    left join public.lead_sources ls on ls.id = l.source_id;

  select count(*) into v_pinned from public.lead_stars s
    where s.user_id = (select auth.uid()) and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', (v_page ->> 'total')::bigint, 'pinned_count', v_pinned);
end $$;

create function public.lead_range_summary(
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
  p_starred_only boolean default false,
  p_temperature public.lead_temperature default null,
  p_starred_by uuid default null,
  p_from integer default null,
  p_to integer default null,
  p_source text default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_page jsonb;
  v_result jsonb;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_from is null or p_to is null or p_from < 1 or p_to < p_from or p_to - p_from >= 10000 or p_from > 1000001 then
    raise exception 'invalid_sl_range' using errcode = '22023';
  end if;

  v_page := private.lead_list_page(p_search, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
    p_overdue_only, p_archived, p_sort, p_dir, p_starred_only, p_temperature, p_starred_by, p_to - p_from + 1, p_from - 1, false, p_source);

  with r as (
    select l.stage_id, l.temperature
    from jsonb_array_elements(v_page -> 'rows') as e(value)
    join public.leads l on l.id = (e.value ->> 'id')::uuid
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'count', (select count(*) from r),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', c.cnt) order by s.position, s.id)
      from (select r.stage_id, count(*) as cnt from r group by r.stage_id) c
      join public.pipeline_stages s on s.id = c.stage_id), '[]'::jsonb),
    'temperatures', (
      select jsonb_build_object(
        'hot', count(*) filter (where r.temperature = 'hot'),
        'medium', count(*) filter (where r.temperature = 'medium'),
        'cold', count(*) filter (where r.temperature = 'cold'),
        'none', count(*) filter (where r.temperature is null))
      from r))
  into v_result;
  return v_result;
end $$;

revoke all on function
  private.lead_list_page(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, boolean, text),
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature, uuid, text),
  public.lead_range_summary(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, text)
from public, anon;
grant execute on function
  private.lead_list_page(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, boolean, text),
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean, public.lead_temperature, uuid, text),
  public.lead_range_summary(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, text)
to authenticated;
