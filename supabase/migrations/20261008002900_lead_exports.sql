-- ---------------------------------------------------------------------------
-- Leads Excel download (Admin). "All leads" downloads every active lead; "New" only the ones this
-- admin hasn't downloaded yet. Each download records its leads per admin (one row per lead rather
-- than a "last created_at" mark, so a lead saved during a download, or restored later, is never
-- skipped). Rows go with their lead.
-- ---------------------------------------------------------------------------

create table public.lead_exports (
  user_id uuid not null references public.profiles (id) on delete cascade,
  lead_id uuid not null references public.leads (id) on delete cascade,
  exported_at timestamptz not null default now(),
  primary key (user_id, lead_id)
);
create index lead_exports_lead_idx on public.lead_exports (lead_id);

alter table public.lead_exports enable row level security;
create policy lead_exports_select on public.lead_exports for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.lead_exports from anon, authenticated;
grant select on public.lead_exports to authenticated;

-- One page of the download, oldest first, continuing after (p_after_created, p_after_id).
-- Security invoker: RLS keeps it to the current company.
create function public.export_leads(
  p_only_new boolean default false,
  p_after_created timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 1000
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
      'niche', n.name, 'stage', s.name, 'status', l.status, 'owner', o.display_name, 'source', l.source,
      'created_at', l.created_at, 'next_follow_up_at', nf.next_due
    ) order by l.created_at, l.id)
    from (
      select x.* from public.leads x
      where x.archived_at is null
        and (p_after_created is null or (x.created_at, x.id) > (p_after_created, p_after_id))
        and (not coalesce(p_only_new, false) or not exists (
          select 1 from public.lead_exports e where e.user_id = (select auth.uid()) and e.lead_id = x.id))
      order by x.created_at, x.id
      limit p_limit
    ) l
    left join public.niches n on n.id = l.niche_id
    left join public.pipeline_stages s on s.id = l.stage_id
    left join public.profiles o on o.id = l.owner_id
    left join lateral (
      select min(f.due_at) as next_due from public.follow_ups f where f.lead_id = l.id and f.state = 'pending'
    ) nf on true
  ), '[]'::jsonb);
end $$;

-- Records a finished download. Only leads the admin can see now (RLS on leads) are recorded.
create function public.mark_leads_exported(p_ids uuid[])
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if private.app_role() is distinct from 'admin' or cardinality(coalesce(p_ids, '{}')) > 1000 then
    perform private.raise_forbidden();
  end if;
  insert into public.lead_exports (user_id, lead_id)
  select (select auth.uid()), l.id
  from public.leads l
  where l.id = any(p_ids) and l.company_id = private.current_company_id()
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- How many active leads this admin hasn't downloaded yet (the "New" button's count).
create function public.lead_export_pending()
returns integer
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if private.app_role() is distinct from 'admin' then
    perform private.raise_forbidden();
  end if;
  return (
    select count(*)::integer from public.leads l
    where l.archived_at is null
      and not exists (select 1 from public.lead_exports e where e.user_id = (select auth.uid()) and e.lead_id = l.id));
end $$;

revoke all on function public.export_leads(boolean, timestamptz, uuid, integer), public.mark_leads_exported(uuid[]),
  public.lead_export_pending() from public, anon;
grant execute on function public.export_leads(boolean, timestamptz, uuid, integer), public.mark_leads_exported(uuid[]),
  public.lead_export_pending() to authenticated;
