-- Removes everything demo.sql created (and anything later attached to those demo records), leaving real data untouched.
-- Run through `scripts/seed-demo.mjs --clean`, which then deletes the demo_* users themselves.

do $$
declare
  demo uuid[];
  demo_leads uuid[];
  kept integer;
begin
  select coalesce(array_agg(id), '{}') into demo from public.profiles where username like 'demo\_%';
  select coalesce(array_agg(id), '{}') into demo_leads from public.leads where created_by = any(demo);

  -- Leads: shares (files cascade), activities, follow-ups (reminders and stars cascade), stars, then the leads.
  delete from public.lead_shares where lead_id = any(demo_leads);
  delete from public.lead_activities where lead_id = any(demo_leads);
  delete from public.follow_ups where lead_id = any(demo_leads);
  delete from public.lead_stars where lead_id = any(demo_leads);
  delete from public.leads where id = any(demo_leads);

  -- Finance: history, entries, monthly series, queued notifications.
  delete from public.finance_activities f where f.entity_id in (
    select id from public.expenses where created_by = any(demo) union all select id from public.capital_entries where created_by = any(demo));
  delete from public.expenses where created_by = any(demo);
  delete from public.capital_entries where created_by = any(demo);
  delete from public.expense_recurrences where created_by = any(demo);
  delete from public.telegram_notifications where recipient_id = any(demo);

  -- Demo niches, unless a real lead now uses one (then it is kept, detached from the demo user).
  update public.niches set merged_into_id = null
    where merged_into_id in (select id from public.niches where name like 'Demo %' and created_by = any(demo));
  delete from public.niches n where n.name like 'Demo %' and n.created_by = any(demo)
    and not exists (select 1 from public.leads l where l.niche_id = n.id);
  update public.niches set created_by = null where created_by = any(demo);
  get diagnostics kept = row_count;
  if kept > 0 then
    raise notice '% demo niche(s) kept because real leads use them', kept;
  end if;

  -- Anything else the demo users touched.
  delete from public.lead_activities where actor_id = any(demo);
  delete from public.finance_activities where actor_id = any(demo);
  delete from public.admin_audit_log where actor_id = any(demo) or target_user_id = any(demo);
end $$;

select count(*) as demo_users_left_to_delete from public.profiles where username like 'demo\_%';
