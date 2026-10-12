-- Faster read policies for tables that hang off a lead.
--
-- They called private.can_access_lead(lead_id) once per row. That function is opaque to the
-- planner and re-runs current_company_id()/app_role() (several lookups) for every row: reading
-- 250 follow-ups took ~400 ms, and every lead list, dashboard and report paid for it.
--
-- Now they check "the lead is visible to me" with EXISTS on public.leads, whose own select
-- policy (leads_select) is exactly the can_access_lead rule: same company, and Admin, or Sales
-- owning the non-archived lead. Its checks are init-plans (evaluated once per query), so the
-- planner can use one semi-join instead of a function call per row. Same access, same results.
--
-- Insert/update policies keep can_access_lead: they check a single row at a time.

drop policy follow_ups_select on public.follow_ups;
create policy follow_ups_select on public.follow_ups for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

drop policy lead_activities_select on public.lead_activities;
create policy lead_activities_select on public.lead_activities for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

drop policy lead_stars_select on public.lead_stars;
create policy lead_stars_select on public.lead_stars for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_lead_user())
    and exists (select 1 from public.leads l where l.id = lead_id));

drop policy follow_up_stars_select on public.follow_up_stars;
create policy follow_up_stars_select on public.follow_up_stars for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_lead_user()) and exists (
    select 1 from public.follow_ups f join public.leads l on l.id = f.lead_id where f.id = follow_up_id));

drop policy reminder_deliveries_select on public.reminder_deliveries;
create policy reminder_deliveries_select on public.reminder_deliveries for select to authenticated
  using (exists (
    select 1 from public.follow_ups f join public.leads l on l.id = f.lead_id where f.id = follow_up_id));

drop policy lead_shares_select on public.lead_shares;
create policy lead_shares_select on public.lead_shares for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));

drop policy lead_share_files_select on public.lead_share_files;
create policy lead_share_files_select on public.lead_share_files for select to authenticated
  using (exists (
    select 1 from public.lead_shares s join public.leads l on l.id = s.lead_id where s.id = share_id));

drop policy share_events_select on public.share_events;
create policy share_events_select on public.share_events for select to authenticated
  using (exists (select 1 from public.leads l where l.id = lead_id));
