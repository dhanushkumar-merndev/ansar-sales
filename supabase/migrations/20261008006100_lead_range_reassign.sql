-- Leads: reassign a Sl No range. After double-clicking two Sl Nos on the Leads list (see 20261008005600), an Admin
-- can move those leads to another salesperson from the range summary.
--
-- * reassign_lead_range: Sl No p_from..p_to of the list with these filters and this sort (private.lead_list_page,
--   the same rows lead_range_summary counts). With p_fingerprint null it only previews: how many leads, from whom,
--   and a fingerprint of the exact ids. With the fingerprint it reassigns, but only if the range still holds the
--   same leads in the same order (offset numbering shifts when leads are added or edited), else 'range_changed'.
-- * Security invoker: RLS and the leads triggers do the rest per row, as for a single reassignment (admin check,
--   valid owner, 'assigned' timeline entry, pending follow-ups and reminders move, stale stars dropped).
-- * At most 1,000 rows per call so the per-row triggers stay well within the statement timeout.
-- Additive: no existing function changes.

create function public.reassign_lead_range(
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
  p_source text default null,
  p_new_owner_id uuid default null,
  p_fingerprint text default null
)
returns jsonb
language plpgsql volatile security invoker set search_path = ''
as $$
declare
  v_page jsonb;
  v_ids uuid[];
  v_fingerprint text;
  v_moved integer;
  v_result jsonb;
begin
  if not private.is_admin() then
    perform private.raise_forbidden();
  end if;
  if p_from is null or p_to is null or p_from < 1 or p_to < p_from or p_from > 1000001 then
    raise exception 'invalid_sl_range' using errcode = '22023';
  end if;
  if p_to - p_from >= 1000 then
    raise exception 'reassign_range_too_large' using errcode = '22023';
  end if;
  if coalesce(p_archived, false) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_new_owner_id is null then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
  -- The people the owner picker offers. The leads trigger still checks every row (private.assert_valid_owner);
  -- this only lets the preview say so before anything is attempted.
  if not exists (select 1 from public.list_lead_staff() s where s.id = p_new_owner_id) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;

  v_page := private.lead_list_page(p_search, p_stage_ids, p_niche_id, p_owner_id, p_created_from, p_created_to,
    p_overdue_only, false, p_sort, p_dir, p_starred_only, p_temperature, p_starred_by, p_to - p_from + 1, p_from - 1, false, p_source);

  select coalesce(array_agg((e.value ->> 'id')::uuid order by e.ord), '{}'::uuid[])
    into v_ids
    from jsonb_array_elements(v_page -> 'rows') with ordinality as e(value, ord);
  v_fingerprint := md5(array_to_string(v_ids, ','));

  if p_fingerprint is null then
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'count', cardinality(v_ids),
      'fingerprint', v_fingerprint,
      'moving', count(*) filter (where l.owner_id is distinct from p_new_owner_id),
      'already_owned', count(*) filter (where l.owner_id = p_new_owner_id),
      'by_owner', coalesce((
        select jsonb_agg(jsonb_build_object('id', o.id, 'display_name', o.display_name, 'count', c.cnt) order by c.cnt desc, o.display_name, o.id)
        from (
          select l2.owner_id, count(*) as cnt
          from public.leads l2
          where l2.id = any(v_ids) and l2.owner_id is distinct from p_new_owner_id
          group by l2.owner_id
        ) c
        join public.profiles o on o.id = c.owner_id), '[]'::jsonb))
      into v_result
      from public.leads l
      where l.id = any(v_ids);
    return v_result;
  end if;

  if p_fingerprint is distinct from v_fingerprint then
    raise exception 'range_changed' using errcode = 'P0001';
  end if;

  update public.leads l
    set owner_id = p_new_owner_id
    where l.id = any(v_ids) and l.owner_id is distinct from p_new_owner_id;
  get diagnostics v_moved = row_count;

  return jsonb_build_object('from', p_from, 'to', p_to, 'count', cardinality(v_ids), 'moved', v_moved);
end $$;

revoke all on function
  public.reassign_lead_range(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, text, uuid, text)
from public, anon;
grant execute on function
  public.reassign_lead_range(text, uuid[], uuid, uuid, timestamptz, timestamptz, boolean, boolean, text, text, boolean, public.lead_temperature, uuid, integer, integer, text, uuid, text)
to authenticated;
