-- Capital entries and expenses record the mode of payment, and can name what was contributed or
-- bought ("Chair") and how many (8 nos).

alter table public.capital_entries
  add column payment_mode text check (payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  add column item text check (item is null or char_length(btrim(item)) between 1 and 120),
  add column quantity integer check (quantity is null or quantity between 1 and 1000000),
  add constraint capital_entries_quantity_needs_item check (quantity is null or item is not null);

alter table public.expenses
  add column payment_mode text check (payment_mode in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other')),
  add column item text check (item is null or char_length(btrim(item)) between 1 and 120),
  add column quantity integer check (quantity is null or quantity between 1 and 1000000),
  add constraint expenses_quantity_needs_item check (quantity is null or item is not null);

grant insert (payment_mode, item, quantity), update (payment_mode, item, quantity) on public.capital_entries to authenticated;
grant insert (payment_mode, item, quantity), update (payment_mode, item, quantity) on public.expenses to authenticated;

-- History now records item and quantity edits too.
create or replace function private.finance_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_type text := case when tg_table_name = 'expenses' then 'expense' else 'capital' end;
  v_new jsonb := to_jsonb(new);
  v_old jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_action text;
begin
  if tg_op = 'INSERT' then
    insert into public.finance_activities (entity_type, entity_id, action, actor_id, changes)
    values (v_type, new.id, 'created', new.created_by,
      v_new - array['id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'archived_at', 'archived_by']);
    return null;
  end if;

  v_old := to_jsonb(old);
  foreach v_key in array array['entry_date', 'expense_date', 'contributor', 'category', 'amount', 'payment_mode', 'item', 'quantity', 'description'] loop
    if v_new ? v_key and (v_new -> v_key) is distinct from (v_old -> v_key) then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old -> v_key, 'to', v_new -> v_key));
    end if;
  end loop;

  v_action := case
    when new.archived_at is not null and old.archived_at is null then 'archived'
    when new.archived_at is null and old.archived_at is not null then 'restored'
    else 'updated' end;

  if v_action <> 'updated' or v_changes <> '{}'::jsonb then
    insert into public.finance_activities (entity_type, entity_id, action, actor_id, changes)
    values (v_type, new.id, v_action, new.updated_by, v_changes);
  end if;
  return null;
end $$;

create index lead_activities_created_idx on public.lead_activities (created_at);
create index follow_ups_due_idx on public.follow_ups (due_at);

-- ---------------------------------------------------------------------------
-- Report helpers
-- ---------------------------------------------------------------------------

-- Inclusive IST date range, at most about three years. Buckets: day up to ~2 months, week up to ~6 months, else month.
create function private.report_bucket(p_from date, p_to date)
returns text
language plpgsql immutable set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 1100 then
    raise exception 'invalid_report_range' using errcode = '22023';
  end if;
  return case when p_to - p_from <= 62 then 'day' when p_to - p_from <= 190 then 'week' else 'month' end;
end $$;

-- Bucket start dates covering the range, in order.
create function private.report_periods(p_from date, p_to date, p_bucket text)
returns table (period date)
language sql immutable set search_path = ''
as $$
  select g::date from generate_series(
    date_trunc(p_bucket, p_from::timestamp), date_trunc(p_bucket, p_to::timestamp), ('1 ' || p_bucket)::interval) g
$$;

-- ---------------------------------------------------------------------------
-- Sales report: whole team for Admin, own leads for Sales (RLS decides which rows are visible).
-- ---------------------------------------------------------------------------
create function public.report_leads(p_from date, p_to date)
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
    select distinct on (a.lead_id, a.meta ->> 'to') a.lead_id, a.meta ->> 'to' as outcome, a.created_at
    from act a where a.type = 'status_changed' and a.meta ->> 'to' in ('won', 'lost')
    order by a.lead_id, a.meta ->> 'to', a.created_at),
  fu as (select f.* from public.follow_ups f join vl l on l.id = f.lead_id),
  stage_rank as (
    select * from (values ('new', 1), ('contacted', 2), ('interested', 3), ('proposal_sent', 4), ('won', 5)) v(status, rnk)),
  reached as (
    select c.id, max(r.rnk) as rnk
    from created c
    left join public.lead_activities a on a.lead_id = c.id and a.type = 'status_changed'
    join stage_rank r on r.status in ('new', c.status::text, a.meta ->> 'to')
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
      select coalesce(jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.status), '[]'::jsonb)
      from (select c.status, count(*) as cnt from created c group by c.status) s),
    'funnel', (
      select jsonb_agg(jsonb_build_object('status', r.status, 'count', (select count(*) from reached x where x.rnk >= r.rnk)) order by r.rnk)
      from stage_rank r),
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
        where p.role in ('sales', 'admin') and (p.is_active or exists (select 1 from vl l where l.owner_id = p.id))
        order by p.display_name
        limit 30
      ) t) end
  ) into v_result;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Finance report: capital and expenses in a range, kept separate (no profit or cash figures).
-- ---------------------------------------------------------------------------
create function public.report_finance(p_from date, p_to date)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_bucket text;
  v_result jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  v_bucket := private.report_bucket(p_from, p_to);

  with
  cap as (select c.* from public.capital_entries c where c.archived_at is null and c.entry_date between p_from and p_to),
  exp as (select e.* from public.expenses e where e.archived_at is null and e.expense_date between p_from and p_to)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'bucket', v_bucket,
      'months', (extract(year from age(date_trunc('month', p_to), date_trunc('month', p_from))) * 12
                 + extract(month from age(date_trunc('month', p_to), date_trunc('month', p_from))) + 1)::int),
    'cards', jsonb_build_object(
      'capital_total', (select coalesce(sum(amount), 0) from cap),
      'capital_entries', (select count(*) from cap),
      'capital_before', (select coalesce(sum(c.amount), 0) from public.capital_entries c where c.archived_at is null and c.entry_date < p_from),
      'expense_total', (select coalesce(sum(amount), 0) from exp),
      'expense_entries', (select count(*) from exp),
      'largest_expense', (select max(amount) from exp),
      'capital_items_quantity', (select coalesce(sum(quantity), 0) from cap),
      'expense_items_quantity', (select coalesce(sum(quantity), 0) from exp),
      'items_distinct', (select count(distinct (k, lower(btrim(item)))) from (
        select 'capital' as k, item from cap where item is not null union all select 'expense', item from exp where item is not null) i)),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'period', p.period, 'capital', coalesce(c.total, 0), 'expense', coalesce(e.total, 0)
      ) order by p.period), '[]'::jsonb)
      from private.report_periods(p_from, p_to, v_bucket) p
      left join (select date_trunc(v_bucket, x.entry_date::timestamp)::date as period, sum(x.amount) as total from cap x group by 1) c on c.period = p.period
      left join (select date_trunc(v_bucket, x.expense_date::timestamp)::date as period, sum(x.amount) as total from exp x group by 1) e on e.period = p.period),
    'categories', (
      select coalesce(jsonb_agg(jsonb_build_object('category', t.category, 'total', t.total, 'entries', t.entries) order by t.total desc), '[]'::jsonb)
      from (select e.category, sum(e.amount) as total, count(*) as entries from exp e group by e.category) t),
    'category_trend', (
      select coalesce(jsonb_agg(jsonb_build_object('period', t.period, 'category', t.category, 'total', t.total) order by t.period, t.category), '[]'::jsonb)
      from (
        select date_trunc(v_bucket, e.expense_date::timestamp)::date as period, e.category, sum(e.amount) as total
        from exp e group by 1, 2
      ) t),
    'contributors', (
      select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'total', t.total, 'entries', t.entries) order by t.total desc, t.name), '[]'::jsonb)
      from (
        select min(c.contributor) as name, sum(c.amount) as total, count(*) as entries
        from cap c group by lower(btrim(c.contributor)) order by sum(c.amount) desc limit 10
      ) t),
    'payment_modes', (
      select coalesce(jsonb_agg(jsonb_build_object('mode', t.mode, 'capital', t.capital, 'expense', t.expense) order by t.capital + t.expense desc), '[]'::jsonb)
      from (
        select m.mode, coalesce(sum(m.amount) filter (where m.kind = 'capital'), 0) as capital,
               coalesce(sum(m.amount) filter (where m.kind = 'expense'), 0) as expense
        from (
          select 'capital' as kind, coalesce(c.payment_mode, 'unspecified') as mode, c.amount from cap c
          union all
          select 'expense', coalesce(e.payment_mode, 'unspecified'), e.amount from exp e
        ) m group by m.mode
      ) t),
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'item', t.item, 'quantity', t.quantity, 'total', t.total, 'entries', t.entries) order by t.total desc, t.item), '[]'::jsonb)
      from (
        select i.kind, min(btrim(i.item)) as item, coalesce(sum(i.quantity), 0) as quantity, sum(i.amount) as total, count(*) as entries
        from (
          select 'capital' as kind, c.item, c.quantity, c.amount from cap c where c.item is not null
          union all
          select 'expense', e.item, e.quantity, e.amount from exp e where e.item is not null
        ) i
        group by i.kind, lower(btrim(i.item)) order by sum(i.amount) desc limit 30
      ) t),
    'top_expenses', (
      select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'date', t.expense_date, 'category', t.category, 'amount', t.amount,
        'item', t.item, 'quantity', t.quantity, 'payment_mode', t.payment_mode, 'description', t.description) order by t.amount desc, t.expense_date desc), '[]'::jsonb)
      from (select e.id, e.expense_date, e.category, e.amount, e.item, e.quantity, e.payment_mode, e.description from exp e order by e.amount desc, e.expense_date desc, e.id limit 10) t)
  ) into v_result;
  return v_result;
end $$;

revoke execute on function public.report_leads(date, date) from public, anon;
revoke execute on function public.report_finance(date, date) from public, anon;
grant execute on function public.report_leads(date, date) to authenticated;
grant execute on function public.report_finance(date, date) to authenticated;
