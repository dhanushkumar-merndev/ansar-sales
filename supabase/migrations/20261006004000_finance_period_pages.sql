-- Finance page month cards, the per-period report, and a typed entry list (search, filters, sort, paging).
-- All run as the caller (RLS applies) and are limited to Admin and Account.

-- Months of one year with expense and capital totals and the expense category split, plus the years that have data.
create function public.finance_year_overview(p_year integer)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  v_from date;
  v_last date;
  v_result jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  if p_year is null or p_year not between 1900 and 2999 then
    raise exception 'invalid_period_query' using errcode = '22023';
  end if;
  v_from := make_date(p_year, 1, 1);
  -- The current year stops at the current month; past years show all twelve; future years show none.
  v_last := case when p_year = extract(year from v_today)::int then date_trunc('month', v_today)::date
                 when p_year < extract(year from v_today)::int then make_date(p_year, 12, 1)
                 else null end;

  with
  exp as (select e.* from public.expenses e where e.archived_at is null and e.expense_date >= v_from - interval '1 month' and e.expense_date < make_date(p_year + 1, 1, 1)),
  cap as (select c.* from public.capital_entries c where c.archived_at is null and c.entry_date >= v_from - interval '1 month' and c.entry_date < make_date(p_year + 1, 1, 1)),
  months as (select g::date as month from generate_series(v_from::timestamp, coalesce(v_last, v_from - 1)::timestamp, interval '1 month') g),
  per as (
    select m.month,
      coalesce((select sum(e.amount) from exp e where date_trunc('month', e.expense_date) = m.month), 0) as expense,
      (select count(*) from exp e where date_trunc('month', e.expense_date) = m.month) as expense_entries,
      coalesce((select sum(c.amount) from cap c where date_trunc('month', c.entry_date) = m.month), 0) as capital,
      (select count(*) from cap c where date_trunc('month', c.entry_date) = m.month) as capital_entries,
      (select coalesce(jsonb_object_agg(t.category, t.total), '{}'::jsonb) from (
        select e.category, sum(e.amount) as total from exp e where date_trunc('month', e.expense_date) = m.month group by e.category) t) as categories
    from months m
  )
  select jsonb_build_object(
    'year', p_year,
    'months', (select coalesce(jsonb_agg(jsonb_build_object(
      'month', to_char(p.month, 'YYYY-MM'), 'expense', p.expense, 'expense_entries', p.expense_entries,
      'capital', p.capital, 'capital_entries', p.capital_entries, 'categories', p.categories) order by p.month desc), '[]'::jsonb) from per p),
    'totals', jsonb_build_object(
      'expense', coalesce((select sum(p.expense) from per p), 0), 'expense_entries', coalesce((select sum(p.expense_entries) from per p), 0),
      'capital', coalesce((select sum(p.capital) from per p), 0), 'capital_entries', coalesce((select sum(p.capital_entries) from per p), 0)),
    'previous_december', jsonb_build_object(
      'expense', coalesce((select sum(e.amount) from exp e where e.expense_date < v_from), 0),
      'capital', coalesce((select sum(c.amount) from cap c where c.entry_date < v_from), 0)),
    'years', (select coalesce(jsonb_agg(y order by y desc), '[]'::jsonb) from (
      select distinct extract(year from e.expense_date)::int as y from public.expenses e where e.archived_at is null
      union select distinct extract(year from c.entry_date)::int from public.capital_entries c where c.archived_at is null
      union select extract(year from v_today)::int) ys)
  ) into v_result;
  return v_result;
end $$;

-- The range report (report_finance) plus comparisons and breakdowns for one month or one year.
create function public.finance_period_report(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_base jsonb;
  v_len interval;
  v_prev_from date;
  v_prev_to date;
  v_month boolean;
  v_bucket text;
  v_result jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  v_base := public.report_finance(p_from, p_to); -- validates the range
  v_month := date_trunc('month', p_from) = p_from and p_to = (date_trunc('month', p_from) + interval '1 month - 1 day')::date;
  if date_trunc('month', p_from) = p_from and p_to = (date_trunc('month', p_to) + interval '1 month - 1 day')::date then
    -- Whole months (a month, a quarter, a year): the previous period is the same number of calendar months.
    v_prev_from := (p_from - make_interval(months => (
      extract(year from age(date_trunc('month', p_to), p_from)) * 12 + extract(month from age(date_trunc('month', p_to), p_from)) + 1)::int))::date;
    v_prev_to := p_from - 1;
  else
    v_len := (p_to - p_from + 1) * interval '1 day';
    v_prev_from := (p_from - v_len)::date;
    v_prev_to := p_from - 1;
  end if;
  v_bucket := case when p_to - p_from <= 62 then 'day' else 'month' end;

  with
  exp as (select e.* from public.expenses e where e.archived_at is null and e.expense_date between p_from and p_to),
  cap as (select c.* from public.capital_entries c where c.archived_at is null and c.entry_date between p_from and p_to),
  periods as (select g::date as period from generate_series(date_trunc(v_bucket, p_from::timestamp), date_trunc(v_bucket, p_to::timestamp), ('1 ' || v_bucket)::interval) g),
  per as (
    select p.period,
      coalesce((select sum(e.amount) from exp e where date_trunc(v_bucket, e.expense_date::timestamp)::date = p.period), 0) as expense,
      coalesce((select sum(c.amount) from cap c where date_trunc(v_bucket, c.entry_date::timestamp)::date = p.period), 0) as capital
    from periods p
  )
  select v_base || jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'is_month', v_month, 'series_bucket', v_bucket),
    'series', (select coalesce(jsonb_agg(jsonb_build_object('period', c.period, 'expense', c.expense, 'capital', c.capital,
        'expense_cumulative', c.expense_cumulative, 'capital_cumulative', c.capital_cumulative) order by c.period), '[]'::jsonb)
      from (select p.*, sum(p.expense) over w as expense_cumulative, sum(p.capital) over w as capital_cumulative
            from per p window w as (order by p.period rows between unbounded preceding and current row)) c),
    'previous', jsonb_build_object('from', v_prev_from, 'to', v_prev_to,
      'expense', (select coalesce(sum(e.amount), 0) from public.expenses e where e.archived_at is null and e.expense_date between v_prev_from and v_prev_to),
      'capital', (select coalesce(sum(c.amount), 0) from public.capital_entries c where c.archived_at is null and c.entry_date between v_prev_from and v_prev_to)),
    'last_year', jsonb_build_object(
      'expense', (select coalesce(sum(e.amount), 0) from public.expenses e where e.archived_at is null
        and e.expense_date between (p_from - interval '1 year')::date and (p_to - interval '1 year')::date),
      'capital', (select coalesce(sum(c.amount), 0) from public.capital_entries c where c.archived_at is null
        and c.entry_date between (p_from - interval '1 year')::date and (p_to - interval '1 year')::date)),
    'avg_prior_6', case when v_month then (
      select round(coalesce(sum(e.amount), 0) / 6, 2) from public.expenses e
      where e.archived_at is null and e.expense_date >= (p_from - interval '6 months')::date and e.expense_date < p_from) end,
    'prev_categories', (select coalesce(jsonb_agg(jsonb_build_object('category', t.category, 'total', t.total)), '[]'::jsonb) from (
      select e.category, sum(e.amount) as total from public.expenses e
      where e.archived_at is null and e.expense_date between v_prev_from and v_prev_to group by e.category) t),
    'recurring_split', jsonb_build_object(
      'monthly', (select coalesce(sum(amount), 0) from exp where recurrence_id is not null),
      'monthly_entries', (select count(*) from exp where recurrence_id is not null),
      'one_off', (select coalesce(sum(amount), 0) from exp where recurrence_id is null),
      'one_off_entries', (select count(*) from exp where recurrence_id is null)),
    'weekday', (select jsonb_agg(jsonb_build_object('dow', d, 'total', coalesce(t.total, 0), 'entries', coalesce(t.entries, 0)) order by d)
      from generate_series(1, 7) d left join (
        select extract(isodow from e.expense_date)::int as dow, sum(e.amount) as total, count(*) as entries from exp e group by 1
      ) t on t.dow = d),
    'size_buckets', (select jsonb_agg(jsonb_build_object('bucket', b.label, 'entries', coalesce(t.entries, 0), 'total', coalesce(t.total, 0)) order by b.n)
      from (values (1, '< ₹500', 0::numeric, 500::numeric), (2, '₹500–2k', 500, 2000), (3, '₹2k–10k', 2000, 10000),
                   (4, '₹10k–50k', 10000, 50000), (5, '≥ ₹50k', 50000, null)) b(n, label, lo, hi)
      left join lateral (select count(*) as entries, sum(e.amount) as total from exp e
        where e.amount >= b.lo and (b.hi is null or e.amount < b.hi)) t on true),
    'recorded_by', (select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'entries', t.entries, 'total', t.total) order by t.entries desc, t.name), '[]'::jsonb)
      from (
        select p.display_name as name, count(*) as entries, sum(x.amount) as total
        from (select created_by, amount from exp union all select created_by, amount from cap) x
        join public.profiles p on p.id = x.created_by
        group by p.id, p.display_name order by count(*) desc limit 10
      ) t),
    'archived', jsonb_build_object(
      'expense', (select count(*) from public.expenses e where e.archived_at is not null and e.expense_date between p_from and p_to),
      'capital', (select count(*) from public.capital_entries c where c.archived_at is not null and c.entry_date between p_from and p_to))
  ) into v_result;
  return v_result;
end $$;

-- One page of expense or capital entries in a date range, with search, filters and an allowlisted sort.
create function public.list_finance_entries(
  p_kind text,
  p_from date,
  p_to date,
  p_search text default null,
  p_category public.expense_category default null,
  p_mode text default null,
  p_recurring boolean default false,
  p_archived boolean default false,
  p_sort text default 'date',
  p_dir text default 'desc',
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  if p_kind not in ('expense', 'capital') or p_from is null or p_to is null or p_from > p_to
     or p_sort not in ('date', 'amount') or p_dir not in ('asc', 'desc')
     or (p_mode is not null and p_mode not in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other', 'unspecified'))
     or (p_kind = 'capital' and (p_category is not null or coalesce(p_recurring, false))) then
    raise exception 'invalid_period_query' using errcode = '22023';
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

  if p_kind = 'expense' then
    with filtered as (
      select e.* from public.expenses e
      where e.expense_date between p_from and p_to
        and (case when coalesce(p_archived, false) then e.archived_at is not null else e.archived_at is null end)
        and (p_category is null or e.category = p_category)
        and (p_mode is null or coalesce(e.payment_mode, 'unspecified') = p_mode)
        and (not coalesce(p_recurring, false) or e.recurrence_id is not null)
        and (v_pattern is null or e.item ilike v_pattern or e.description ilike v_pattern)
    ), page as (
      select f.*, row_number() over (order by
        case when p_sort = 'date' and p_dir = 'desc' then f.expense_date end desc,
        case when p_sort = 'date' and p_dir = 'asc' then f.expense_date end asc,
        case when p_sort = 'amount' and p_dir = 'desc' then f.amount end desc,
        case when p_sort = 'amount' and p_dir = 'asc' then f.amount end asc,
        case when p_dir = 'desc' then f.id end desc, case when p_dir = 'asc' then f.id end asc) as rn
      from filtered f order by rn limit p_limit offset p_offset
    )
    select (select count(*) from filtered),
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pg.id, 'expense_date', pg.expense_date, 'category', pg.category, 'amount', pg.amount, 'payment_mode', pg.payment_mode,
        'item', pg.item, 'quantity', pg.quantity, 'description', pg.description, 'archived_at', pg.archived_at, 'updated_at', pg.updated_at,
        'recurrence', (select jsonb_build_object('active', r.active, 'next_date', r.next_date) from public.expense_recurrences r where r.id = pg.recurrence_id),
        'author', (select jsonb_build_object('display_name', p.display_name) from public.profiles p where p.id = pg.created_by)
      ) order by pg.rn), '[]'::jsonb) from page pg)
    into v_total, v_items;
  else
    with filtered as (
      select c.* from public.capital_entries c
      where c.entry_date between p_from and p_to
        and (case when coalesce(p_archived, false) then c.archived_at is not null else c.archived_at is null end)
        and (p_mode is null or coalesce(c.payment_mode, 'unspecified') = p_mode)
        and (v_pattern is null or c.item ilike v_pattern or c.description ilike v_pattern or c.contributor ilike v_pattern)
    ), page as (
      select f.*, row_number() over (order by
        case when p_sort = 'date' and p_dir = 'desc' then f.entry_date end desc,
        case when p_sort = 'date' and p_dir = 'asc' then f.entry_date end asc,
        case when p_sort = 'amount' and p_dir = 'desc' then f.amount end desc,
        case when p_sort = 'amount' and p_dir = 'asc' then f.amount end asc,
        case when p_dir = 'desc' then f.id end desc, case when p_dir = 'asc' then f.id end asc) as rn
      from filtered f order by rn limit p_limit offset p_offset
    )
    select (select count(*) from filtered),
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pg.id, 'entry_date', pg.entry_date, 'contributor', pg.contributor, 'amount', pg.amount, 'payment_mode', pg.payment_mode,
        'item', pg.item, 'quantity', pg.quantity, 'description', pg.description, 'archived_at', pg.archived_at, 'updated_at', pg.updated_at,
        'author', (select jsonb_build_object('display_name', p.display_name) from public.profiles p where p.id = pg.created_by)
      ) order by pg.rn), '[]'::jsonb) from page pg)
    into v_total, v_items;
  end if;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

revoke all on function public.finance_year_overview(integer) from public, anon;
revoke all on function public.finance_period_report(date, date) from public, anon;
revoke all on function public.list_finance_entries(text, date, date, text, public.expense_category, text, boolean, boolean, text, text, integer, integer) from public, anon;
grant execute on function public.finance_year_overview(integer), public.finance_period_report(date, date),
  public.list_finance_entries(text, date, date, text, public.expense_category, text, boolean, boolean, text, text, integer, integer)
  to authenticated;
