-- Leads Excel download: "Choose dates" downloads the active leads added in a date range
-- (p_created_from inclusive, p_created_before exclusive). Otherwise as in 20261008002900.

drop function public.export_leads(boolean, timestamptz, uuid, integer);

create function public.export_leads(
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
      'niche', n.name, 'stage', s.name, 'status', l.status, 'owner', o.display_name, 'source', l.source,
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
    left join lateral (
      select min(f.due_at) as next_due from public.follow_ups f where f.lead_id = l.id and f.state = 'pending'
    ) nf on true
  ), '[]'::jsonb);
end $$;

revoke all on function public.export_leads(boolean, timestamptz, uuid, integer, timestamptz, timestamptz) from public, anon;
grant execute on function public.export_leads(boolean, timestamptz, uuid, integer, timestamptz, timestamptz) to authenticated;
