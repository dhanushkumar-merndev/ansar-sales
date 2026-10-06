-- Capital is grouped like expenses: by year, then by month within `p_year`.
-- Same signature, so existing grants are kept by create or replace.
create or replace function public.finance_period_totals(
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
  if p_kind not in ('capital', 'expense')
     or (p_year is not null and p_year not between 1900 and 2999)
     or (p_kind = 'capital' and p_category is not null) then
    raise exception 'invalid_period_query' using errcode = '22023';
  end if;
  p_archived := coalesce(p_archived, false);
  if p_year is not null then
    v_from := make_date(p_year, 1, 1);
    v_to := make_date(p_year + 1, 1, 1);
  end if;

  with entries as (
    select c.entry_date as entry_date, c.amount
    from public.capital_entries c
    where p_kind = 'capital' and (c.archived_at is not null) = p_archived
    union all
    select e.expense_date, e.amount
    from public.expenses e
    where p_kind = 'expense' and (e.archived_at is not null) = p_archived
      and (p_category is null or e.category = p_category)
  )
  select coalesce(jsonb_agg(jsonb_build_object('period', t.period, 'entries', t.entries, 'total', t.total) order by t.period desc), '[]'::jsonb)
  into v_result
  from (
    select
      case when p_year is null then extract(year from x.entry_date)::int::text else to_char(x.entry_date, 'YYYY-MM') end as period,
      count(*) as entries,
      sum(x.amount) as total
    from entries x
    where p_year is null or (x.entry_date >= v_from and x.entry_date < v_to)
    group by 1
  ) t;
  return v_result;
end $$;
