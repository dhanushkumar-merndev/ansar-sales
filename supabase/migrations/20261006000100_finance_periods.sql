-- Year / month totals for the grouped Finance lists.
-- Capital is grouped by year; expenses by year, then by month within a year.
-- security invoker: the caller's RLS applies, plus an explicit finance-role check.
create function public.finance_period_totals(
  p_kind text,
  p_archived boolean default false,
  p_category public.expense_category default null,
  p_year integer default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_from date;
  v_to date;
  v_result jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  if p_kind not in ('capital', 'expense') or (p_year is not null and (p_kind <> 'expense' or p_year not between 1900 and 2999)) then
    raise exception 'invalid_period_query' using errcode = '22023';
  end if;
  p_archived := coalesce(p_archived, false);

  if p_kind = 'capital' then
    select coalesce(jsonb_agg(jsonb_build_object('period', t.period, 'entries', t.entries, 'total', t.total) order by t.period desc), '[]'::jsonb)
    into v_result
    from (
      select extract(year from c.entry_date)::int::text as period, count(*) as entries, sum(c.amount) as total
      from public.capital_entries c
      where (c.archived_at is not null) = p_archived
      group by 1
    ) t;
  elsif p_year is null then
    select coalesce(jsonb_agg(jsonb_build_object('period', t.period, 'entries', t.entries, 'total', t.total) order by t.period desc), '[]'::jsonb)
    into v_result
    from (
      select extract(year from e.expense_date)::int::text as period, count(*) as entries, sum(e.amount) as total
      from public.expenses e
      where (e.archived_at is not null) = p_archived
        and (p_category is null or e.category = p_category)
      group by 1
    ) t;
  else
    v_from := make_date(p_year, 1, 1);
    v_to := make_date(p_year + 1, 1, 1);
    select coalesce(jsonb_agg(jsonb_build_object('period', t.period, 'entries', t.entries, 'total', t.total) order by t.period desc), '[]'::jsonb)
    into v_result
    from (
      select to_char(date_trunc('month', e.expense_date), 'YYYY-MM') as period, count(*) as entries, sum(e.amount) as total
      from public.expenses e
      where (e.archived_at is not null) = p_archived
        and (p_category is null or e.category = p_category)
        and e.expense_date >= v_from and e.expense_date < v_to
      group by 1
    ) t;
  end if;
  return v_result;
end $$;

revoke all on function public.finance_period_totals(text, boolean, public.expense_category, integer) from public, anon;
grant execute on function public.finance_period_totals(text, boolean, public.expense_category, integer) to authenticated;
