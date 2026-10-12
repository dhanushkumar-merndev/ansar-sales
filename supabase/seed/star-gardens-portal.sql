-- What the demo clients did in the portal (views, downloads, approvals, change requests, a pinned note).
-- Runs after scripts/seed-star-gardens.mjs has created the client logins demo_sg_client_hari (SG-DEMO-01)
-- and demo_sg_client_villa (SG-DEMO-02, switched off).

begin;
set local session_replication_role = replica;

do $$
declare
  hari uuid := (select id from public.profiles where username = 'demo_sg_client_hari');
  villa uuid := (select id from public.profiles where username = 'demo_sg_client_villa');
  p1 uuid := (select id from public.projects where code = 'SG-DEMO-01');
  p2 uuid := (select id from public.projects where code = 'SG-DEMO-02');
  v record;
begin
  if num_nulls(hari, villa, p1, p2) > 0 then
    raise exception 'Run star-gardens.sql and create the demo client logins first.';
  end if;

  for v in
    select pv.id, pv.file_id, pv.project_id, pv.status, pv.client_comment, pv.version_no, pv.created_at, f.name,
      case when pv.project_id = p1 then hari else villa end as client
    from public.project_file_versions pv join public.project_files f on f.id = pv.file_id
    where pv.project_id in (p1, p2) and f.archived_at is null
      and pv.status in ('approved', 'client_approved', 'changes_requested', 'superseded')
      and (pv.status <> 'changes_requested' or pv.client_comment is not null)
      and (pv.status <> 'superseded' or pv.client_comment is not null)
      and f.folder_id not in (select id from public.project_folders where restricted)
  loop
    -- Opened in the portal (and the photos and the approved layout were downloaded too).
    insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, from_client, created_at)
    values (v.project_id, v.file_id, v.id, 'client_viewed', v.client, true, v.created_at + interval '5 hours');
    if v.name like 'Site photo%' or v.status = 'client_approved' then
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, from_client, created_at)
      values (v.project_id, v.file_id, v.id, 'client_downloaded', v.client, true, v.created_at + interval '6 hours');
    end if;
    if v.status = 'client_approved' then
      update public.project_file_versions set status_by = v.client, status_at = v.created_at + interval '1 day' where id = v.id;
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, from_client, created_at)
      values (v.project_id, v.file_id, v.id, 'client_approved', v.client, true, v.created_at + interval '1 day');
    elsif v.client_comment is not null then
      -- Changes asked by the client (the latest one is still "changes requested", older ones were replaced since).
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, from_client, comment, created_at)
      values (v.project_id, v.file_id, v.id, 'client_changes', v.client, true, v.client_comment, v.created_at + interval '1 day');
      insert into public.project_file_comments (version_id, project_id, body, author_id, from_client, created_at)
      values (v.id, v.project_id, v.client_comment, v.client, true, v.created_at + interval '1 day');
      if v.status = 'changes_requested' then
        update public.project_file_versions set status_by = v.client, status_at = v.created_at + interval '1 day' where id = v.id;
      end if;
    end if;
  end loop;

  -- A pinned note from the client on the approved layout.
  insert into public.project_file_comments (version_id, project_id, page, x_pct, y_pct, body, author_id, from_client, created_at)
  select pv.id, p1, 1, 48, 30, 'Can we add a small swing here for the kids?', hari, true, now() - interval '7 days'
  from public.project_file_versions pv join public.project_files f on f.id = pv.file_id
  where f.project_id = p1 and f.name = 'Layout plan.pdf' and pv.status = 'client_approved';
end $$;

commit;

select (select count(*) from public.project_file_events where from_client and project_id in (select id from public.projects where code like 'SG-DEMO-%')) as client_events;
