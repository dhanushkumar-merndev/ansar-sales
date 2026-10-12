-- ---------------------------------------------------------------------------
-- Client portal for projects. A project client is a 'client' login (no ads client) linked
-- through project_members (member_role 'client'). Clients never read tables directly; these
-- definer RPCs return only what a client may see:
--   * the timeline (phase names, dates, status — no owners, notes or remarks)
--   * files whose latest client-visible version is approved or later (never drafts or
--     anything awaiting review), never the restricted "Payment proofs" folder
--   * their payment schedule and what they paid
-- Opening, downloading, approving or asking for changes is recorded and the team is told.
-- ---------------------------------------------------------------------------

-- Clients: ads clients (ads_client_id) or project clients (none).
alter table public.profiles drop constraint profiles_company_check;
alter table public.profiles add constraint profiles_company_check check (
  ((role in ('super_admin', 'ads_manager')) = (company_id is null)) and (ads_client_id is null or role = 'client'));

create function private.my_project_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(m.project_id), '{}') from public.project_members m
  join public.profiles p on p.id = m.user_id and p.is_active and p.role = 'client'
  join public.projects pr on pr.id = m.project_id and pr.archived_at is null
  where m.user_id = (select auth.uid()) and m.member_role = 'client' and m.removed_at is null
$$;

-- New logins may name a project ('crm_project_id'): the client joins it in the same transaction.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_role public.app_role;
  v_company uuid;
  v_client uuid;
  v_project uuid;
  v_extra public.app_role[];
begin
  if new.raw_app_meta_data ? 'crm_role'
     and not exists (select 1 from public.profiles p where p.id = new.id) then
    v_role := (new.raw_app_meta_data ->> 'crm_role')::public.app_role;
    if v_role not in ('super_admin', 'ads_manager') then
      v_company := nullif(new.raw_app_meta_data ->> 'crm_company_id', '')::uuid;
      if v_company is null or not exists (select 1 from public.companies c where c.id = v_company and c.archived_at is null) then
        raise exception 'company_required' using errcode = '23514';
      end if;
    end if;
    if v_role = 'client' then
      v_client := nullif(new.raw_app_meta_data ->> 'crm_ads_client_id', '')::uuid;
      v_project := nullif(new.raw_app_meta_data ->> 'crm_project_id', '')::uuid;
      if v_client is not null then
        if not exists (select 1 from public.ads_clients c where c.id = v_client and c.company_id = v_company) then
          raise exception 'ads_client_required' using errcode = '23514';
        end if;
      elsif v_project is null or not exists (select 1 from public.projects p where p.id = v_project and p.company_id = v_company and p.archived_at is null) then
        raise exception 'ads_client_required' using errcode = '23514';
      end if;
    end if;
    v_extra := case when v_role in ('client', 'super_admin', 'ads_manager') then '{}' else coalesce((
      select array_agg(distinct x::public.app_role order by x::public.app_role)
      from jsonb_array_elements_text(case when jsonb_typeof(new.raw_app_meta_data -> 'crm_extra_roles') = 'array'
        then new.raw_app_meta_data -> 'crm_extra_roles' else '[]'::jsonb end) x
      where x <> v_role::text), '{}') end;
    if (private.is_project_role(v_role) or exists (select 1 from unnest(v_extra) x where private.is_project_role(x)))
       and not exists (select 1 from public.companies c where c.id = v_company and 'projects' = any(c.features)) then
      raise exception 'feature_disabled' using errcode = '23514';
    end if;
    insert into public.profiles (id, username, display_name, role, extra_roles, company_id, active_company_id, ads_client_id)
    values (
      new.id, new.raw_app_meta_data ->> 'crm_username', btrim(new.raw_app_meta_data ->> 'crm_display_name'),
      v_role, v_extra, v_company,
      case when v_role = 'super_admin' then (select c.id from public.companies c where c.archived_at is null order by c.created_at, c.id limit 1) end,
      v_client
    );
    if v_project is not null then
      insert into public.project_members (project_id, user_id, member_role, added_by)
      values (v_project, new.id, 'client', nullif(new.raw_app_meta_data ->> 'crm_created_by', '')::uuid);
    end if;
    insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
    values (
      (select p.id from public.profiles p where p.id = nullif(new.raw_app_meta_data ->> 'crm_created_by', '')::uuid),
      new.id, 'user_created',
      jsonb_strip_nulls(jsonb_build_object('role', v_role, 'extra_roles', case when cardinality(v_extra) > 0 then to_jsonb(v_extra) end,
        'company_id', v_company, 'ads_client_id', v_client, 'project_id', v_project))
    );
  end if;
  return new;
end $$;

-- Admin / architect manager: may this project get a client login? Returns its company.
create function public.project_client_login_check(p_project_id uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_manage_project(p_project_id) then
    perform private.raise_forbidden();
  end if;
  return (select p.company_id from public.projects p where p.id = p_project_id);
end $$;

create function public.project_client_logins(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.can_manage_project(p_project_id) then
    perform private.raise_forbidden();
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name, 'is_active', p.is_active,
      'created_at', p.created_at,
      'last_seen_at', (select max(e.created_at) from public.project_file_events e where e.project_id = p_project_id and e.actor_id = p.id)) order by p.created_at)
    from public.project_members m join public.profiles p on p.id = m.user_id
    where m.project_id = p_project_id and m.member_role = 'client' and m.removed_at is null), '[]'::jsonb);
end $$;

create function public.set_project_client_login(p_project_id uuid, p_user_id uuid, p_is_active boolean default null, p_password_reset boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.can_manage_project(p_project_id) or not exists (
    select 1 from public.project_members m join public.profiles p on p.id = m.user_id and p.role = 'client' and p.ads_client_id is null
    where m.project_id = p_project_id and m.user_id = p_user_id and m.member_role = 'client' and m.removed_at is null) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_is_active is not null then
    update public.profiles set is_active = p_is_active where id = p_user_id;
  end if;
  insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
  values ((select auth.uid()), p_user_id, case when p_password_reset then 'password_reset' else 'user_updated' end,
    jsonb_strip_nulls(jsonb_build_object('is_active', p_is_active, 'project_id', p_project_id)));
end $$;

-- ---------------------------------------------------------------------------
-- Portal reads
-- ---------------------------------------------------------------------------
-- The version a client sees for a file: the newest approved one, or one they approved or asked to change.
-- "Changes requested" by the team before approval (no client comment) never reaches the client.
create function private.client_version(p_file_id uuid)
returns public.project_file_versions
language sql stable security definer set search_path = ''
as $$
  select v.* from public.project_file_versions v
  where v.file_id = p_file_id
    and (v.status in ('approved', 'client_approved') or (v.status = 'changes_requested' and v.client_comment is not null))
  order by v.version_no desc limit 1
$$;

create function public.my_project_portal()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ids uuid[] := private.my_project_ids();
begin
  if cardinality(v_ids) = 0 then
    perform private.raise_forbidden();
  end if;
  return jsonb_build_object(
    'company', (select jsonb_build_object('name', c.name, 'brand_highlight', c.brand_highlight, 'logo_path', c.logo_path)
      from public.profiles p join public.companies c on c.id = p.company_id where p.id = (select auth.uid())),
    'me', (select p.display_name from public.profiles p where p.id = (select auth.uid())),
    'projects', (select jsonb_agg(jsonb_build_object(
      'id', pr.id, 'code', pr.code, 'name', pr.name, 'site_address', pr.site_address, 'start_date', pr.start_date, 'end_date', pr.end_date,
      'status', pr.status, 'color', pr.color,
      'team', coalesce((select jsonb_agg(jsonb_build_object('name', p.display_name, 'role', m.member_role) order by m.member_role)
        from public.project_members m join public.profiles p on p.id = m.user_id
        where m.project_id = pr.id and m.removed_at is null and m.member_role in ('architect_manager', 'landscape_designer')), '[]'::jsonb),
      'phases', coalesce((select jsonb_agg(jsonb_build_object('id', ph.id, 'position', ph.position, 'category', ph.category, 'name', ph.name,
          'color', ph.color, 'planned_start', ph.planned_start, 'deadline', ph.deadline, 'actual_start', ph.actual_start,
          'submitted_on', ph.submitted_on, 'status', ph.status, 'needs_client_approval', ph.needs_client_approval,
          'items', coalesce((select jsonb_agg(jsonb_build_object('title', i.title, 'done', i.done_at is not null) order by i.position, i.id)
            from public.project_phase_items i where i.phase_id = ph.id and i.archived_at is null), '[]'::jsonb))
        order by ph.position, ph.id) from public.project_phases ph where ph.project_id = pr.id and ph.archived_at is null and ph.status <> 'skipped'), '[]'::jsonb),
      'files', coalesce((select jsonb_agg(x order by x ->> 'updated_at' desc) from (
        select jsonb_build_object('id', f.id, 'name', f.name, 'kind', f.kind, 'folder', fo.name, 'folder_key', fo.system_key,
          'version_id', cv.id, 'version_no', cv.version_no, 'status', cv.status, 'size_bytes', cv.size_bytes, 'mime_type', cv.mime_type,
          'client_comment', cv.client_comment, 'updated_at', coalesce(cv.status_at, cv.created_at)) as x
        from public.project_files f
        join public.project_folders fo on fo.id = f.folder_id and not fo.restricted and fo.archived_at is null
        cross join lateral private.client_version(f.id) cv
        where f.project_id = pr.id and f.archived_at is null and cv.id is not null) y), '[]'::jsonb),
      'payments', jsonb_build_object(
        'contract_value', (select f.contract_value from public.project_financials f where f.project_id = pr.id),
        'received', (select coalesce(sum(p.amount), 0) from public.project_payments p where p.project_id = pr.id and p.archived_at is null),
        'milestones', coalesce((select jsonb_agg(private.milestone_json(m, true) - 'notes' order by m.position, m.id)
          from public.project_payment_milestones m where m.project_id = pr.id and m.archived_at is null), '[]'::jsonb))
    ) order by pr.start_date desc) from public.projects pr where pr.id = any(v_ids))
  );
end $$;

-- Client opens or downloads a file version they may see: records it and returns the object path.
create function public.portal_file_access(p_version_id uuid, p_download boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v public.project_file_versions%rowtype;
  v_cv public.project_file_versions%rowtype;
begin
  select * into v from public.project_file_versions where id = p_version_id;
  if not found or not (v.project_id = any(private.my_project_ids())) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_cv from private.client_version(v.file_id);
  if v_cv.id is distinct from v.id or exists (select 1 from public.project_files f join public.project_folders fo on fo.id = f.folder_id
      where f.id = v.file_id and (fo.restricted or f.archived_at is not null)) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- One "opened" per file per hour is enough history.
  if not exists (select 1 from public.project_file_events e where e.version_id = v.id and e.actor_id = (select auth.uid())
      and e.type = case when p_download then 'client_downloaded' else 'client_viewed' end and e.created_at > now() - interval '1 hour') then
    insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, from_client)
    values (v.project_id, v.file_id, v.id, case when p_download then 'client_downloaded' else 'client_viewed' end, (select auth.uid()), true);
  end if;
  return jsonb_build_object('path', v.storage_path, 'name', v.original_name);
end $$;

-- Client approves a file, or asks for changes with a comment.
create function public.portal_file_decision(p_version_id uuid, p_approve boolean, p_comment text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v public.project_file_versions%rowtype;
  v_cv public.project_file_versions%rowtype;
  v_file public.project_files%rowtype;
  v_comment text := left(nullif(btrim(coalesce(p_comment, '')), ''), 2000);
begin
  select * into v from public.project_file_versions where id = p_version_id for update;
  if not found or not (v.project_id = any(private.my_project_ids())) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_cv from private.client_version(v.file_id);
  if v_cv.id is distinct from v.id then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not p_approve and v_comment is null then
    raise exception 'comment_required' using errcode = '22023';
  end if;
  select * into v_file from public.project_files where id = v.file_id;
  update public.project_file_versions set status = case when p_approve then 'client_approved' else 'changes_requested' end,
    client_comment = v_comment, status_at = now(), status_by = (select auth.uid())
  where id = v.id;
  insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, from_client, comment)
  values (v.project_id, v.file_id, v.id, case when p_approve then 'client_approved' else 'client_changes' end, (select auth.uid()), true, v_comment);
  if v_comment is not null then
    insert into public.project_file_comments (version_id, project_id, body, author_id, from_client)
    values (v.id, v.project_id, v_comment, (select auth.uid()), true);
  end if;
  perform private.enqueue_for_project(v.project_id, array['architect_manager']::public.project_member_role[], true, 'client_feedback',
    private.project_payload(v.project_id, jsonb_build_object('file', v_file.name, 'file_id', v_file.id, 'version_no', v.version_no,
      'approved', p_approve, 'comment', v_comment, 'client', private.display_name((select auth.uid())))),
    'client_feedback:' || v.id || ':' || p_approve::text, (select auth.uid()));
  if v.uploaded_by is not null then
    perform private.enqueue_notification(v.uploaded_by, 'client_feedback',
      private.project_payload(v.project_id, jsonb_build_object('file', v_file.name, 'file_id', v_file.id, 'version_no', v.version_no,
        'approved', p_approve, 'comment', v_comment, 'client', private.display_name((select auth.uid())))),
      'client_feedback:' || v.id || ':' || p_approve::text, (select auth.uid()));
  end if;
end $$;

-- Client note pinned on an image (or general).
create function public.portal_add_comment(p_version_id uuid, p_body text, p_x numeric default null, p_y numeric default null, p_page integer default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v public.project_file_versions%rowtype;
  v_cv public.project_file_versions%rowtype;
begin
  select * into v from public.project_file_versions where id = p_version_id;
  if not found or not (v.project_id = any(private.my_project_ids())) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_cv from private.client_version(v.file_id);
  if v_cv.id is distinct from v.id then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  insert into public.project_file_comments (version_id, project_id, body, author_id, from_client, x_pct, y_pct, page)
  values (v.id, v.project_id, left(btrim(p_body), 2000), (select auth.uid()), true, p_x, p_y, p_page);
end $$;

create function public.portal_file_comments(p_version_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v public.project_file_versions%rowtype;
begin
  select * into v from public.project_file_versions where id = p_version_id;
  if not found or not (v.project_id = any(private.my_project_ids())) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- Clients see their own notes only (team notes stay internal).
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'body', c.body, 'x_pct', c.x_pct, 'y_pct', c.y_pct, 'created_at', c.created_at)
    order by c.created_at) from public.project_file_comments c where c.version_id = p_version_id and c.from_client), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Alert: client feedback (team) — add the kind
-- ---------------------------------------------------------------------------
alter table public.telegram_notifications drop constraint telegram_notifications_kind_check;
alter table public.telegram_notifications add constraint telegram_notifications_kind_check check (kind in (
  'recurring_expense', 'lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
  'expense_added', 'capital_added', 'library_file_added', 'digest_sales', 'digest_admin', 'digest_finance', 'test',
  'ads_client_new', 'ad_account_problem',
  'lead_handed_off', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted',
  'phase_changes', 'project_at_risk', 'site_visit_reminder', 'payment_due', 'payment_overdue', 'payment_received',
  'boq_status', 'snag_assigned', 'project_completed', 'client_feedback'));

create or replace function private.notification_kinds_for(p_role public.app_role)
returns text[]
language sql immutable set search_path = ''
as $$
  select case p_role
    when 'admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'ads_client_new', 'ad_account_problem', 'test',
      'lead_handed_off', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted', 'phase_changes',
      'project_at_risk', 'site_visit_reminder', 'payment_due', 'payment_overdue', 'payment_received', 'boq_status', 'snag_assigned',
      'project_completed', 'client_feedback']
    when 'super_admin' then array['lead_created', 'lead_assigned', 'lead_closed', 'follow_up_changed', 'overdue_nag',
      'expense_added', 'capital_added', 'recurring_expense', 'library_file_added', 'digest_sales', 'digest_admin',
      'digest_finance', 'ads_client_new', 'ad_account_problem', 'test',
      'lead_handed_off', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted', 'phase_changes',
      'project_at_risk', 'site_visit_reminder', 'payment_due', 'payment_overdue', 'payment_received', 'boq_status', 'snag_assigned',
      'project_completed', 'client_feedback']
    when 'sales' then array['lead_assigned', 'follow_up_changed', 'overdue_nag', 'library_file_added', 'digest_sales', 'test', 'site_visit_reminder']
    when 'account' then array['expense_added', 'capital_added', 'recurring_expense', 'digest_finance', 'test',
      'payment_due', 'payment_overdue', 'payment_received']
    when 'ads_manager' then array['ads_client_new', 'ad_account_problem', 'test']
    when 'architect_manager' then array['test', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_submitted',
      'project_at_risk', 'site_visit_reminder', 'boq_status', 'snag_assigned', 'project_completed', 'client_feedback']
    when 'landscape_designer' then array['test', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue', 'phase_changes',
      'site_visit_reminder', 'boq_status', 'snag_assigned', 'project_completed', 'client_feedback']
    when 'execution' then array['test', 'project_assigned', 'phase_assigned', 'phase_due_soon', 'phase_overdue',
      'boq_status', 'snag_assigned', 'project_completed', 'client_feedback']
    else array[]::text[] end
$$;

revoke all on function
  private.my_project_ids(),
  private.client_version(uuid),
  public.project_client_login_check(uuid),
  public.project_client_logins(uuid),
  public.set_project_client_login(uuid, uuid, boolean, boolean),
  public.my_project_portal(),
  public.portal_file_access(uuid, boolean),
  public.portal_file_decision(uuid, boolean, text),
  public.portal_add_comment(uuid, text, numeric, numeric, integer),
  public.portal_file_comments(uuid)
from public, anon, authenticated;

grant execute on function
  public.project_client_login_check(uuid),
  public.project_client_logins(uuid),
  public.set_project_client_login(uuid, uuid, boolean, boolean),
  public.my_project_portal(),
  public.portal_file_access(uuid, boolean),
  public.portal_file_decision(uuid, boolean, text),
  public.portal_add_comment(uuid, text, numeric, numeric, integer),
  public.portal_file_comments(uuid)
to authenticated;
