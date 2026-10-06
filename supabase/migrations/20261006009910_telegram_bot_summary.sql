-- What the Telegram bot shows a connected user when they message it ("Today" / help).
-- Only the webhook (service role) calls this. It looks the user up by their private chat and
-- returns one small block per role, with the same numbers as the daily digests
-- (private.enqueue_digests). Dates are IST days.

create function public.telegram_bot_summary(p_chat_id bigint)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_day date := (v_now at time zone 'Asia/Kolkata')::date;
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_day_end timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_month_start date := date_trunc('month', v_day)::date;
  v_next_month date := (date_trunc('month', v_day) + interval '1 month')::date;
  v_user record;
  v_company uuid;
  v_out jsonb;
begin
  select p.id, p.display_name, p.role::text as role, coalesce(p.active_company_id, p.company_id) as company_id
    into v_user
  from public.telegram_connections t
  join public.profiles p on p.id = t.user_id and p.is_active
  where t.chat_id = p_chat_id and t.status = 'connected';
  if not found then
    return jsonb_build_object('connected', false);
  end if;
  v_company := v_user.company_id;
  v_out := jsonb_build_object('connected', true, 'name', v_user.display_name, 'role', v_user.role, 'date', v_day);

  -- My follow-ups (people who own leads).
  if v_user.role in ('sales', 'admin', 'super_admin') then
    v_out := v_out || (
      select jsonb_build_object(
        'today', count(*) filter (where f.due_at >= v_day_start and f.due_at < v_day_end),
        'overdue', count(*) filter (where f.due_at < v_now))
      from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.assignee_id = v_user.id and f.state = 'pending'
    ) || jsonb_build_object('tasks', (
      select coalesce(jsonb_agg(t order by t.due_at, t.id), '[]'::jsonb) from (
        select f.id, f.task, f.due_at, l.name as lead_name, f.due_at < v_now as overdue
        from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where f.assignee_id = v_user.id and f.state = 'pending' and f.due_at < v_day_end
        order by f.due_at, f.id limit 5
      ) t));
  end if;

  -- Admin: the company's day at a glance.
  if v_user.role in ('admin', 'super_admin') and v_company is not null then
    v_out := v_out || jsonb_build_object('team', jsonb_build_object(
      'new_leads', (select count(*) from public.leads l
        where l.company_id = v_company and l.created_at >= v_day_start and l.created_at < v_day_end),
      'won', (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id
        where l.company_id = v_company and a.type = 'status_changed'
          and coalesce(a.meta ->> 'to_kind', a.meta ->> 'to') = 'won'
          and a.created_at >= v_day_start and a.created_at < v_day_end),
      'overdue', (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where l.company_id = v_company and f.state = 'pending' and f.due_at < v_now)));
  end if;

  -- Account: this month in the user's books (every company sharing them).
  if v_user.role = 'account' and v_company is not null then
    v_out := v_out || (
      with books as (
        select x.id from public.companies x
        where x.archived_at is null
          and x.finance_group_id = (select c.finance_group_id from public.companies c where c.id = v_company)
      )
      select jsonb_build_object('finance', jsonb_build_object(
        'month', to_char(v_month_start, 'YYYY-MM'),
        'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.company_id in (select id from books)
          and e.archived_at is null and e.expense_date >= v_month_start and e.expense_date < v_next_month), 0),
        'expense_count', (select count(*) from public.expenses e where e.company_id in (select id from books)
          and e.archived_at is null and e.expense_date >= v_month_start and e.expense_date < v_next_month),
        'capital_total', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id in (select id from books)
          and k.archived_at is null and k.entry_date >= v_month_start and k.entry_date < v_next_month), 0)))
    );
  end if;

  -- Ads manager: ad accounts that stopped syncing, in the companies they manage.
  if v_user.role = 'ads_manager' then
    v_out := v_out || (
      select jsonb_build_object('ads', jsonb_build_object(
        'problem_count', count(*),
        'problem_names', coalesce((array_agg(coalesce(a.name, 'act_' || a.act_id) order by a.name nulls last))[1:3], '{}')))
      from public.ad_accounts a
      join public.ads_manager_companies m on m.company_id = a.company_id and m.user_id = v_user.id
      where a.status = 'error'
    );
  end if;

  return v_out;
end $$;

revoke all on function public.telegram_bot_summary(bigint) from public, anon, authenticated;
grant execute on function public.telegram_bot_summary(bigint) to service_role;
