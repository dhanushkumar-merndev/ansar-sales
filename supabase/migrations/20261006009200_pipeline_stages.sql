-- Custom pipeline per company.
--
-- * pipeline_stages: each company's ordered stages. Every stage has a kind: open, won or lost.
-- * leads.stage_id is the lead's stage. leads.status becomes the stage's kind (open / won /
--   lost), kept in sync by a trigger, so every won/lost metric keeps working unchanged.
-- * Existing leads move to the matching seeded stage (New, Contacted, Interested, Proposal sent,
--   Won, Lost); old timeline entries get stage names, kinds and ids written into their meta.

create type public.lead_outcome as enum ('open', 'won', 'lost');

create table public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id),
  name text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  position integer not null,
  kind public.lead_outcome not null default 'open',
  color text not null default 'slate' check (color in ('slate', 'blue', 'sky', 'violet', 'amber', 'orange', 'pink', 'emerald', 'red')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index pipeline_stages_active_name_key on public.pipeline_stages (company_id, lower(name)) where archived_at is null;
create index pipeline_stages_company_idx on public.pipeline_stages (company_id, position, id);

create trigger pipeline_stages_touch before update on public.pipeline_stages
  for each row execute function private.touch_updated_at();

-- Today's six stages, for existing companies and every new one.
create function private.seed_pipeline(p_company_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.pipeline_stages (company_id, name, position, kind, color)
  values
    (p_company_id, 'New', 1, 'open', 'slate'),
    (p_company_id, 'Contacted', 2, 'open', 'blue'),
    (p_company_id, 'Interested', 3, 'open', 'violet'),
    (p_company_id, 'Proposal sent', 4, 'open', 'amber'),
    (p_company_id, 'Won', 5, 'won', 'emerald'),
    (p_company_id, 'Lost', 6, 'lost', 'red')
$$;

select private.seed_pipeline(c.id) from public.companies c;

create function private.companies_seed_pipeline()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform private.seed_pipeline(new.id);
  return null;
end $$;

create trigger companies_seed_pipeline after insert on public.companies
  for each row execute function private.companies_seed_pipeline();

-- ---------------------------------------------------------------------------
-- Leads: stage_id, and status narrowed to the stage's kind
-- ---------------------------------------------------------------------------
alter table public.leads add column stage_id uuid references public.pipeline_stages (id);

-- Triggers stay off for the backfill: no "edited" history or version bumps.
alter table public.leads disable trigger user;
update public.leads l set stage_id = s.id
from (values ('new', 'New'), ('contacted', 'Contacted'), ('interested', 'Interested'), ('proposal_sent', 'Proposal sent'), ('won', 'Won'), ('lost', 'Lost')) as m(status, name), public.pipeline_stages s
where m.status = l.status::text and s.company_id = l.company_id and s.name = m.name;
alter table public.leads enable trigger user;

alter table public.leads alter column stage_id set not null;
create index leads_stage_idx on public.leads (company_id, stage_id) where archived_at is null;

-- History: stage names, kinds and ids instead of the old fixed keys.
update public.lead_activities a set meta = a.meta || jsonb_build_object(
    'from', fm.name, 'to', tm.name,
    'from_kind', case when fm.status in ('won', 'lost') then fm.status else 'open' end,
    'to_kind', case when tm.status in ('won', 'lost') then tm.status else 'open' end,
    'from_stage_id', fs.id, 'to_stage_id', ts.id)
from public.leads l,
  (values ('new', 'New'), ('contacted', 'Contacted'), ('interested', 'Interested'), ('proposal_sent', 'Proposal sent'), ('won', 'Won'), ('lost', 'Lost')) as fm(status, name),
  (values ('new', 'New'), ('contacted', 'Contacted'), ('interested', 'Interested'), ('proposal_sent', 'Proposal sent'), ('won', 'Won'), ('lost', 'Lost')) as tm(status, name),
  public.pipeline_stages fs, public.pipeline_stages ts
where a.type = 'status_changed' and l.id = a.lead_id
  and fm.status = a.meta ->> 'from' and tm.status = a.meta ->> 'to'
  and fs.company_id = l.company_id and fs.name = fm.name
  and ts.company_id = l.company_id and ts.name = tm.name;

update public.lead_activities a set meta = a.meta || jsonb_build_object('status', m.name)
from (values ('new', 'New'), ('contacted', 'Contacted'), ('interested', 'Interested'), ('proposal_sent', 'Proposal sent'), ('won', 'Won'), ('lost', 'Lost')) as m(status, name)
where a.type = 'lead_created' and m.status = a.meta ->> 'status';

-- The old fixed list goes; functions that took it are recreated below.
drop function public.create_lead(text, text, text, text, uuid, text, public.lead_status, uuid, text, timestamptz, text, boolean);
drop function public.list_leads(text, public.lead_status[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean);

drop index public.leads_owner_status_idx;
drop index public.leads_status_idx;
alter table public.leads alter column status drop default;
alter table public.leads alter column status type public.lead_outcome
  using (case when status::text in ('won', 'lost') then status::text else 'open' end)::public.lead_outcome;
alter table public.leads alter column status set default 'open';
drop type public.lead_status;
create index leads_owner_status_idx on public.leads (owner_id, status) where archived_at is null;
create index leads_status_idx on public.leads (status) where archived_at is null;

-- Sets the default stage on insert, validates stage changes and keeps status = the stage's kind.
-- Runs after zz_company_guard, so company_id is final.
create function private.leads_stage_sync()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_stage public.pipeline_stages%rowtype;
begin
  if tg_op = 'INSERT' and new.stage_id is null then
    select * into v_stage from public.pipeline_stages s
    where s.company_id = new.company_id and s.archived_at is null and s.kind = 'open'
    order by s.position, s.id limit 1;
    if not found then
      raise exception 'stage_not_found' using errcode = 'P0002';
    end if;
  else
    select * into v_stage from public.pipeline_stages s where s.id = new.stage_id;
    if (tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id)
       and (not found or v_stage.company_id <> new.company_id or v_stage.archived_at is not null) then
      raise exception 'stage_not_found' using errcode = 'P0002';
    end if;
  end if;
  new.stage_id := v_stage.id;
  new.status := v_stage.kind;
  return new;
end $$;

create trigger zz_stage_sync before insert or update on public.leads
  for each row execute function private.leads_stage_sync();

-- Stage changes in the timeline carry names (readable after a rename), kinds and ids.
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

-- ---------------------------------------------------------------------------
-- Lead RPCs with stages
-- ---------------------------------------------------------------------------
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
  p_allow_duplicate boolean default false
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

  insert into public.leads (name, phone, phone_normalized, email, niche_id, stage_id, owner_id, created_by)
  values (p_name, p_phone, p_phone_normalized, p_email, v_niche, p_stage_id, v_owner, (select auth.uid()))
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
      and ($1::text is null or l.name ilike $1 or l.email ilike $1 or ($2::text is not null and l.phone_normalized like $2))
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

  -- In the Starred view, pinned leads come first (most recently pinned on top).
  execute format($q$
    with page as (
      select l.*, nf.next_due, nf.overdue, st.pinned_at as star_pinned_at, st.lead_id is not null as is_starred,
        row_number() over (order by case when $12 then st.pinned_at end desc nulls last, %s %s nulls last, l.id %s) as rn
      from public.leads l
      left join lateral (
        select min(f.due_at) as next_due, bool_or(f.due_at < now()) as overdue
        from public.follow_ups f
        where f.lead_id = l.id and f.state = 'pending'
      ) nf on true
      left join public.lead_stars st on st.lead_id = l.id and st.user_id = (select auth.uid())
      %s
      order by case when $12 then st.pinned_at end desc nulls last, %s %s nulls last, l.id %s
      limit $10 offset $11
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'name', p.name, 'phone', p.phone, 'email', p.email, 'status', p.status, 'stage_id', p.stage_id,
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

-- Where a lead came from (manual entry, or a Facebook Lead Ads form; see the Meta migration).
alter table public.leads
  add column source text not null default 'manual' check (source in ('manual', 'facebook')),
  add column source_meta jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Stage management (company admin)
-- ---------------------------------------------------------------------------
-- Adds (p_id null) or edits a stage. Kind changes re-sync the leads in that stage.
create function public.save_pipeline_stage(p_id uuid, p_name text, p_kind public.lead_outcome, p_color text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_old public.pipeline_stages%rowtype;
  v_id uuid;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_id is null then
    insert into public.pipeline_stages (company_id, name, kind, color, position)
    values (v_company, private.clean_label(p_name), coalesce(p_kind, 'open'), coalesce(p_color, 'slate'),
      -- New open stages go before the first won/lost stage; won/lost stages go last.
      case when coalesce(p_kind, 'open') = 'open'
        then coalesce((select min(s.position) from public.pipeline_stages s where s.company_id = v_company and s.archived_at is null and s.kind <> 'open'), 1000)
        else coalesce((select max(s.position) from public.pipeline_stages s where s.company_id = v_company), 0) + 1 end)
    returning id into v_id;
    -- Make room: shift the won/lost stages after the new open one.
    if coalesce(p_kind, 'open') = 'open' then
      update public.pipeline_stages s set position = s.position + 1
      where s.company_id = v_company and s.id <> v_id and s.position >= (select x.position from public.pipeline_stages x where x.id = v_id);
    end if;
  else
    select * into v_old from public.pipeline_stages s where s.id = p_id and s.company_id = v_company for update;
    if not found or v_old.archived_at is not null then
      raise exception 'stage_not_found' using errcode = 'P0002';
    end if;
    update public.pipeline_stages set
      name = coalesce(private.clean_label(p_name), name),
      kind = coalesce(p_kind, kind),
      color = coalesce(p_color, color)
    where id = p_id
    returning id into v_id;
    if p_kind is not null and p_kind <> v_old.kind then
      -- The sync trigger re-reads the stage's kind on any update.
      update public.leads l set stage_id = l.stage_id where l.stage_id = p_id;
    end if;
  end if;
  perform private.assert_pipeline_complete(v_company);
  return v_id;
exception when unique_violation then
  raise exception 'stage_name_taken' using errcode = '23505';
end $$;

-- A pipeline needs at least one open, one won and one lost stage.
create function private.assert_pipeline_complete(p_company_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if (select count(distinct s.kind) from public.pipeline_stages s where s.company_id = p_company_id and s.archived_at is null) < 3 then
    raise exception 'pipeline_incomplete' using errcode = '23514';
  end if;
end $$;

-- Sets the order of the company's active stages (all of them, in the new order).
create function public.reorder_pipeline_stages(p_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if coalesce(cardinality(p_ids), 0) <> (select count(*) from public.pipeline_stages s where s.company_id = v_company and s.archived_at is null)
     or exists (select 1 from unnest(p_ids) x where not exists (
       select 1 from public.pipeline_stages s where s.id = x and s.company_id = v_company and s.archived_at is null)) then
    raise exception 'invalid_stage_order' using errcode = '22023';
  end if;
  update public.pipeline_stages s set position = x.ord
  from unnest(p_ids) with ordinality as x(id, ord)
  where s.id = x.id;
end $$;

-- Archives a stage, moving its leads to another active stage first (their history records the move).
create function public.archive_pipeline_stage(p_id uuid, p_move_to uuid default null)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_company uuid := private.current_company_id();
  v_moved integer := 0;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.pipeline_stages s where s.id = p_id and s.company_id = v_company and s.archived_at is null) then
    raise exception 'stage_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.leads l where l.stage_id = p_id) then
    if p_move_to is null or p_move_to = p_id or not exists (
      select 1 from public.pipeline_stages s where s.id = p_move_to and s.company_id = v_company and s.archived_at is null) then
      raise exception 'stage_has_leads' using errcode = '23514';
    end if;
    update public.leads l set stage_id = p_move_to where l.stage_id = p_id;
    get diagnostics v_moved = row_count;
  end if;
  update public.pipeline_stages set archived_at = now() where id = p_id;
  perform private.assert_pipeline_complete(v_company);
  return v_moved;
end $$;

-- ---------------------------------------------------------------------------
-- Dashboards and reports: stage breakdowns use the company's stages
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_admin(p_days integer default 30, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_from is not null or p_to is not null then
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 1100 then
      raise exception 'invalid_range' using errcode = '22023';
    end if;
    v_from := p_from;
    v_to := p_to;
  else
    p_days := least(greatest(coalesce(p_days, 30), 7), 365);
    v_from := v_today - (p_days - 1);
    v_to := v_today;
  end if;

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_to - v_from + 1),
    'cards', (
      select jsonb_build_object(
        'active_leads', count(*) filter (where l.status = 'open'),
        'won_leads', count(*) filter (where l.status = 'won'),
        'lost_leads', count(*) filter (where l.status = 'lost'),
        'today_pending', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.state = 'pending' and (f.due_at at time zone 'Asia/Kolkata')::date = v_today),
        'overdue', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.state = 'pending' and f.due_at < now()))
      from public.leads l where l.archived_at is null),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object('date', d.day::date, 'count', coalesce(c.cnt, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as d(day)
      left join (
        select (l.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as cnt
        from public.leads l
        where l.archived_at is null and l.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
          and l.created_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata')
        group by 1
      ) c on c.day = d.day::date),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', s.cnt)
        order by s.position, s.id), '[]'::jsonb)
      from (
        select st.id, st.name, st.kind, st.color, st.position, count(*) as cnt
        from public.leads l join public.pipeline_stages st on st.id = l.stage_id
        where l.archived_at is null group by st.id
      ) s),
    'salespeople', (
      select coalesce(jsonb_agg(x order by (x ->> 'active')::int desc, x ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.display_name,
          'active', count(l.id) filter (where l.status = 'open'),
          'won', count(l.id) filter (where l.status = 'won'),
          'lost', count(l.id) filter (where l.status = 'lost')) as x
        from public.profiles p
        join public.leads l on l.owner_id = p.id and l.archived_at is null
        group by p.id, p.display_name
        order by count(l.id) filter (where l.status = 'open') desc, p.display_name
        limit 15
      ) t),
    'niches', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'count', t.cnt) order by t.cnt desc, t.name), '[]'::jsonb)
      from (
        select n.name, count(*) as cnt from public.leads l join public.niches n on n.id = l.niche_id
        where l.archived_at is null group by n.name order by count(*) desc, n.name limit 8
      ) t)
  ) into v_result;
  return v_result;
end $$;

create or replace function public.dashboard_sales(p_days integer default 30, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_today date := private.ist_today();
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  if p_from is not null or p_to is not null then
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 1100 then
      raise exception 'invalid_range' using errcode = '22023';
    end if;
    v_from := p_from;
    v_to := p_to;
  else
    p_days := least(greatest(coalesce(p_days, 30), 7), 365);
    v_from := v_today - (p_days - 1);
    v_to := v_today;
  end if;

  select jsonb_build_object(
    'range', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_to - v_from + 1),
    'cards', (
      select jsonb_build_object(
        'active_leads', count(*) filter (where l.status = 'open'),
        'won_leads', count(*) filter (where l.status = 'won'),
        'lost_leads', count(*) filter (where l.status = 'lost'),
        'today_pending', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.assignee_id = v_uid and f.state = 'pending' and (f.due_at at time zone 'Asia/Kolkata')::date = v_today),
        'overdue', (
          select count(*) from public.follow_ups f join public.leads fl on fl.id = f.lead_id and fl.archived_at is null
          where f.assignee_id = v_uid and f.state = 'pending' and f.due_at < now()))
      from public.leads l where l.owner_id = v_uid and l.archived_at is null),
    'stages', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', s.cnt)
        order by s.position, s.id), '[]'::jsonb)
      from (
        select st.id, st.name, st.kind, st.color, st.position, count(*) as cnt
        from public.leads l join public.pipeline_stages st on st.id = l.stage_id
        where l.owner_id = v_uid and l.archived_at is null group by st.id
      ) s),
    'activity', (
      select coalesce(jsonb_agg(jsonb_build_object('date', d.day::date, 'count', coalesce(c.cnt, 0)) order by d.day), '[]'::jsonb)
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as d(day)
      left join (
        select (a.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as cnt
        from public.lead_activities a
        where a.actor_id = v_uid and a.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
          and a.created_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata')
        group by 1
      ) c on c.day = d.day::date)
  ) into v_result;
  return v_result;
end $$;

-- Funnel: how many leads created in the range reached each open stage (or won), by the stage's
-- current position. Lost stages are not part of the funnel.
create or replace function public.report_leads(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_bucket text;
  v_start timestamptz;
  v_end timestamptz;
  v_admin boolean := private.is_admin();
  v_result jsonb;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  v_bucket := private.report_bucket(p_from, p_to);
  v_start := p_from::timestamp at time zone 'Asia/Kolkata';
  v_end := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';

  with
  vl as (select l.* from public.leads l where l.archived_at is null),
  created as (select l.* from vl l where l.created_at >= v_start and l.created_at < v_end),
  act as (
    select a.* from public.lead_activities a join vl l on l.id = a.lead_id
    where a.created_at >= v_start and a.created_at < v_end),
  closes as (
    select distinct on (a.lead_id, a.meta ->> 'to_kind') a.lead_id, a.meta ->> 'to_kind' as outcome, a.created_at
    from act a where a.type = 'status_changed' and a.meta ->> 'to_kind' in ('won', 'lost')
    order by a.lead_id, a.meta ->> 'to_kind', a.created_at),
  fu as (select f.* from public.follow_ups f join vl l on l.id = f.lead_id),
  stages as (
    select s.id, s.name, s.kind, s.color, s.position,
      row_number() over (order by case when s.kind = 'won' then 1 else 0 end, s.position, s.id) as rnk
    from public.pipeline_stages s
    where s.company_id = private.current_company_id() and s.archived_at is null and s.kind <> 'lost'),
  reached as (
    select c.id, max(r.rnk) as rnk
    from created c
    left join public.lead_activities a on a.lead_id = c.id and a.type = 'status_changed'
    join stages r on r.rnk = 1 or r.id = c.stage_id or r.id::text = a.meta ->> 'to_stage_id'
    group by c.id)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'bucket', v_bucket),
    'scope', case when v_admin then 'team' else 'mine' end,
    'cards', jsonb_build_object(
      'created', (select count(*) from created),
      'won', (select count(*) from closes where outcome = 'won'),
      'lost', (select count(*) from closes where outcome = 'lost'),
      'notes', (select count(*) from act where type = 'note'),
      'calls', (select count(*) from act where type::text = 'call_logged'),
      'follow_ups_scheduled', (select count(*) from fu where fu.created_at >= v_start and fu.created_at < v_end),
      'follow_ups_completed', (select count(*) from fu where fu.completed_at >= v_start and fu.completed_at < v_end),
      'overdue_now', (select count(*) from fu where fu.state = 'pending' and fu.due_at < now()),
      'avg_days_to_win', (
        select round(avg(extract(epoch from (c.created_at - l.created_at)) / 86400)::numeric, 1)
        from closes c join vl l on l.id = c.lead_id where c.outcome = 'won')),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', p.period, 'created', coalesce(n.cnt, 0), 'won', coalesce(w.won, 0), 'lost', coalesce(w.lost, 0)
      ) order by p.period), '[]'::jsonb)
      from private.report_periods(p_from, p_to, v_bucket) p
      left join (
        select date_trunc(v_bucket, c.created_at at time zone 'Asia/Kolkata')::date as period, count(*) as cnt
        from created c group by 1
      ) n on n.period = p.period
      left join (
        select date_trunc(v_bucket, c.created_at at time zone 'Asia/Kolkata')::date as period,
          count(*) filter (where c.outcome = 'won') as won, count(*) filter (where c.outcome = 'lost') as lost
        from closes c group by 1
      ) w on w.period = p.period),
    'activity_trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', p.period,
        'notes', coalesce(t.notes, 0), 'calls', coalesce(t.calls, 0), 'follow_ups', coalesce(t.follow_ups, 0)
      ) order by p.period), '[]'::jsonb)
      from private.report_periods(p_from, p_to, v_bucket) p
      left join (
        select date_trunc(v_bucket, a.created_at at time zone 'Asia/Kolkata')::date as period,
          count(*) filter (where a.type = 'note') as notes,
          count(*) filter (where a.type::text = 'call_logged') as calls,
          count(*) filter (where a.type = 'follow_up_completed') as follow_ups
        from act a group by 1
      ) t on t.period = p.period),
    'cohort_status', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kind', s.kind, 'color', s.color, 'count', s.cnt)
        order by s.position, s.id), '[]'::jsonb)
      from (
        select st.id, st.name, st.kind, st.color, st.position, count(*) as cnt
        from created c join public.pipeline_stages st on st.id = c.stage_id group by st.id
      ) s),
    'funnel', (
      select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'kind', r.kind, 'color', r.color,
        'count', (select count(*) from reached x where x.rnk >= r.rnk)) order by r.rnk), '[]'::jsonb)
      from stages r),
    'niches', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'created', t.created, 'won', t.won) order by t.created desc, t.name), '[]'::jsonb)
      from (
        select n.name, count(*) as created, count(*) filter (where c.status = 'won') as won
        from created c join public.niches n on n.id = c.niche_id
        group by n.name order by count(*) desc, n.name limit 10
      ) t),
    'activity_types', (
      select coalesce(jsonb_agg(jsonb_build_object('type', t.type, 'count', t.cnt) order by t.cnt desc, t.type), '[]'::jsonb)
      from (select a.type::text as type, count(*) as cnt from act a group by a.type) t),
    'heatmap', (
      select coalesce(jsonb_agg(jsonb_build_object('dow', t.dow, 'hour', t.hour, 'count', t.cnt)), '[]'::jsonb)
      from (
        select extract(isodow from a.created_at at time zone 'Asia/Kolkata')::int as dow,
               extract(hour from a.created_at at time zone 'Asia/Kolkata')::int as hour, count(*) as cnt
        from act a where a.type <> 'lead_created' group by 1, 2
      ) t),
    'follow_up_outcomes', (
      select jsonb_build_object(
        'on_time', count(*) filter (where f.state = 'completed' and f.completed_at <= f.due_at),
        'late', count(*) filter (where f.state = 'completed' and f.completed_at > f.due_at),
        'cancelled', count(*) filter (where f.state = 'cancelled'),
        'overdue', count(*) filter (where f.state = 'pending' and f.due_at < now()),
        'upcoming', count(*) filter (where f.state = 'pending' and f.due_at >= now()))
      from fu f where f.due_at >= v_start and f.due_at < v_end),
    'salespeople', case when not v_admin then null else (
      select coalesce(jsonb_agg(x order by (x ->> 'created')::int desc, x ->> 'name'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'id', p.id, 'name', p.display_name,
          'created', (select count(*) from created c where c.owner_id = p.id),
          'won', (select count(*) from closes c join vl l on l.id = c.lead_id where c.outcome = 'won' and l.owner_id = p.id),
          'lost', (select count(*) from closes c join vl l on l.id = c.lead_id where c.outcome = 'lost' and l.owner_id = p.id),
          'follow_ups_completed', (select count(*) from fu where fu.completed_by = p.id and fu.completed_at >= v_start and fu.completed_at < v_end),
          'notes', (select count(*) from act a where a.actor_id = p.id and a.type = 'note'),
          'calls', (select count(*) from act a where a.actor_id = p.id and a.type::text = 'call_logged')) as x
        from public.profiles p
        where p.role in ('sales', 'admin', 'super_admin')
          -- This company's people, plus anyone else (e.g. the super admin) who owns its leads.
          and ((p.company_id = private.current_company_id() and p.is_active) or exists (select 1 from vl l where l.owner_id = p.id))
        order by p.display_name
        limit 30
      ) t) end
  ) into v_result;
  return v_result;
end $$;

-- Follow-ups show the lead's stage.
create or replace function public.list_follow_ups(
  p_view text default 'pending',
  p_assignee_id uuid default null,
  p_search text default null,
  p_limit integer default 20,
  p_offset integer default 0,
  p_due_from timestamptz default null,
  p_due_to timestamptz default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_role public.app_role := private.app_role();
  v_uid uuid := (select auth.uid());
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
  v_tomorrow_start timestamptz := v_today_start + interval '1 day';
  v_total bigint;
  v_items jsonb;
  v_pinned bigint;
begin
  if v_role is null or v_role not in ('admin', 'sales') then
    perform private.raise_forbidden();
  end if;
  if p_view not in ('overdue', 'today', 'upcoming', 'pending', 'completed', 'cancelled', 'starred') then
    raise exception 'invalid_view' using errcode = '22023';
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
  if p_due_from is not null and p_due_to is not null and p_due_to <= p_due_from then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if v_role <> 'admin' then
    p_assignee_id := null;
  end if;
  if v_term is not null then
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  with filtered as (
    select f.id, f.state, st.pinned_at,
      case when p_view = 'completed' then f.completed_at
           when p_view = 'cancelled' then f.cancelled_at
           else f.due_at end as sort_ts
    from public.follow_ups f
    join public.leads l on l.id = f.lead_id and l.archived_at is null
    left join public.follow_up_stars st on st.follow_up_id = f.id and st.user_id = v_uid
    where (p_assignee_id is null or f.assignee_id = p_assignee_id)
      and (v_pattern is null or l.name ilike v_pattern or f.task ilike v_pattern)
      and (p_due_from is null or f.due_at >= p_due_from)
      and (p_due_to is null or f.due_at < p_due_to)
      and case p_view
        when 'overdue' then f.state = 'pending' and f.due_at < now()
        when 'today' then f.state = 'pending' and f.due_at >= v_today_start and f.due_at < v_tomorrow_start
        when 'upcoming' then f.state = 'pending' and f.due_at >= v_tomorrow_start
        when 'pending' then f.state = 'pending'
        when 'completed' then f.state = 'completed'
        when 'starred' then st.follow_up_id is not null
        else f.state = 'cancelled' end
  ),
  numbered as (
    -- Starred: pinned first (latest pin on top), then pending before closed.
    -- Pending views: soonest first. History views: newest first. id is the tie-breaker.
    select fl.id, row_number() over (order by
      case when p_view = 'starred' then fl.pinned_at end desc nulls last,
      case when p_view = 'starred' then fl.state <> 'pending' end asc,
      case when p_view in ('completed', 'cancelled') then null else fl.sort_ts end asc,
      case when p_view in ('completed', 'cancelled') then fl.sort_ts end desc,
      case when p_view in ('completed', 'cancelled') then null else fl.id end asc,
      case when p_view in ('completed', 'cancelled') then fl.id end desc) as rn
    from filtered fl
  ),
  page as (
    select n.id, n.rn from numbered n where n.rn > p_offset and n.rn <= p_offset + p_limit
  )
  select
    (select count(*) from filtered),
    (select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'task', f.task, 'due_at', f.due_at, 'state', f.state, 'outcome', f.outcome,
      'completed_at', f.completed_at, 'cancelled_at', f.cancelled_at, 'revision', f.revision,
      'overdue', f.state = 'pending' and f.due_at < now(),
      'lead', jsonb_build_object('id', l.id, 'name', l.name, 'phone', l.phone, 'status', l.status, 'stage_id', l.stage_id),
      'assignee', jsonb_build_object('id', a.id, 'display_name', a.display_name),
      'reminder', (
        select jsonb_build_object('state', d.state, 'attempts', d.attempts, 'last_error', d.last_error, 'sent_at', d.sent_at)
        from public.reminder_deliveries d
        where d.follow_up_id = f.id and d.revision = f.revision
        limit 1),
      'starred', st.follow_up_id is not null, 'pinned_at', st.pinned_at
    ) order by pg.rn), '[]'::jsonb)
    from page pg
    join public.follow_ups f on f.id = pg.id
    join public.leads l on l.id = f.lead_id
    join public.profiles a on a.id = f.assignee_id
    left join public.follow_up_stars st on st.follow_up_id = f.id and st.user_id = v_uid)
  into v_total, v_items;

  select count(*) into v_pinned from public.follow_up_stars s
    where s.user_id = v_uid and s.pinned_at is not null;

  return jsonb_build_object('items', v_items, 'total', v_total, 'pinned_count', v_pinned);
end $$;

-- ---------------------------------------------------------------------------
-- Row Level Security and privileges
-- ---------------------------------------------------------------------------
alter table public.pipeline_stages enable row level security;
create policy pipeline_stages_select on public.pipeline_stages for select to authenticated
  using ((select private.is_lead_user()) and company_id = (select private.current_company_id()));

revoke all on public.pipeline_stages from anon, authenticated;
grant select on public.pipeline_stages to authenticated;

-- Stages are written only through the functions above; status follows the stage.
revoke insert, update on public.leads from authenticated;
grant insert (name, phone, phone_normalized, email, niche_id, stage_id, owner_id, created_by)
  on public.leads to authenticated;
grant update (name, phone, phone_normalized, email, niche_id, stage_id, owner_id, archived_at)
  on public.leads to authenticated;

revoke all on function
  private.seed_pipeline(uuid),
  private.companies_seed_pipeline(),
  private.leads_stage_sync(),
  private.assert_pipeline_complete(uuid),
  public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean),
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean),
  public.save_pipeline_stage(uuid, text, public.lead_outcome, text),
  public.reorder_pipeline_stages(uuid[]),
  public.archive_pipeline_stage(uuid, uuid)
from public, anon;

grant execute on function
  public.create_lead(text, text, text, text, uuid, text, uuid, uuid, text, timestamptz, text, boolean),
  public.list_leads(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, integer, integer, boolean),
  public.save_pipeline_stage(uuid, text, public.lead_outcome, text),
  public.reorder_pipeline_stages(uuid[]),
  public.archive_pipeline_stage(uuid, uuid)
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.pipeline_stages;
  end if;
end $$;
