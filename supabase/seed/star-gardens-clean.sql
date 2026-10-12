-- Removes the Star Gardens demo data (SG-DEMO-* projects and everything of the demo_sg_* users), leaving real
-- data untouched. Run through `scripts/seed-star-gardens.mjs --clean`, which first deletes the placeholder files
-- from storage and then deletes the demo_sg_* users themselves.

begin;

do $$
declare
  co uuid := (select id from public.companies where normalized_name = 'star gardens');
  demo uuid[];
  projs uuid[];
  demo_leads uuid[];
begin
  select coalesce(array_agg(id), '{}') into demo from public.profiles where username like 'demo\_sg\_%';
  select coalesce(array_agg(id), '{}') into projs from public.projects where company_id = co and code like 'SG-DEMO-%';

  -- Projects: their visits, then the projects (phases, files, payments, BOQ, logs, snags, members, history cascade).
  delete from public.site_visits where project_id = any(projs) or assigned_to = any(demo) or created_by = any(demo);
  delete from public.projects where id = any(projs);

  -- Leads of the demo BDMs.
  select coalesce(array_agg(id), '{}') into demo_leads from public.leads where company_id = co and created_by = any(demo);
  delete from public.lead_shares where lead_id = any(demo_leads);
  delete from public.lead_activities where lead_id = any(demo_leads);
  delete from public.follow_ups where lead_id = any(demo_leads);
  delete from public.lead_stars where lead_id = any(demo_leads);
  delete from public.leads where id = any(demo_leads);
  delete from public.niches n where n.company_id = co and n.name like 'Demo SG %'
    and not exists (select 1 from public.leads l where l.niche_id = n.id);

  -- Anything else the demo users touched.
  delete from public.project_members where user_id = any(demo);
  delete from public.telegram_notifications where recipient_id = any(demo);
  delete from public.app_notifications where recipient_id = any(demo);
  -- Year/month folder colours the demo set (company-wide, so not removed with the projects).
  delete from public.project_folder_colors where company_id = co and updated_by = any(demo);
  delete from public.lead_activities where actor_id = any(demo);
  delete from public.admin_audit_log where actor_id = any(demo) or target_user_id = any(demo);
end $$;

commit;

select count(*) as demo_sg_users_left_to_delete from public.profiles where username like 'demo\_sg\_%';
