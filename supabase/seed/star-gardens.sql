-- Star Gardens demo data: leads → handover → projects with timelines, files, site visits, BOQ, payments.
-- Every record belongs to the demo_sg_* users and every project code starts with SG-DEMO-, so
-- star-gardens-clean.sql removes exactly this. Run through scripts/seed-star-gardens.mjs, which creates the
-- users first, then uploads placeholder files and creates the client logins (star-gardens-portal.sql).
--
-- It covers the edge cases on purpose: overdue and late phases, parallel phases, a phase past the project end,
-- partly paid / overdue / zero-amount payments, a schedule that doesn't add up to 100%, a check-in far from the
-- site, a missed visit, every file status, an extended end date, a nearly full storage quota, on hold / cancelled / completed /
-- archived projects, a project without a lead, one without a team, long and non-English names, folders three
-- levels deep (one empty, one archived), projects that started last year / across New Year / next month, coloured
-- year and month folders, payments that spill into the next part or run ahead of the schedule, a post-dated
-- cheque, a phase owned by someone who left, and bell notifications of every project kind (plus an unknown one).
--
-- Triggers are off (as in demo.sql) so dates can lie in the past and no Telegram alert is queued; the
-- history that triggers would write is written here. Foreign keys are not checked either, so every
-- reference comes from rows inserted here.

begin;
set local session_replication_role = replica;

-- ----- helpers (dropped at the end) -----------------------------------------
create function private.demo_sg_at(d date, h integer default 11) returns timestamptz
language sql stable as $$ select (d + make_time(h, 0, 0)) at time zone 'Asia/Kolkata' $$;

-- A Tiptap document: optional bold lead-in, text, optional red line.
create function private.demo_sg_doc(p_text text, p_bold text default null, p_red text default null) returns jsonb
language sql immutable as $$
  select jsonb_build_object('type', 'doc', 'content',
    jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
      case when p_bold is null then jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_text))
      else jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', p_bold, 'marks', jsonb_build_array(jsonb_build_object('type', 'bold'))),
        jsonb_build_object('type', 'text', 'text', ' ' || p_text)) end))
    || case when p_red is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
      jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_red, 'marks', jsonb_build_array(
        jsonb_build_object('type', 'textStyle', 'attrs', jsonb_build_object('color', '#dc2626'))))))) end)
$$;

create function private.demo_sg_name(p uuid) returns text
language sql stable as $$ select display_name from public.profiles where id = p $$;

-- The project part of a notification payload (what the worker's projectLine / projectPath read).
create function private.demo_sg_pl(p uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object('project', name, 'code', code, 'client', client_name, 'project_id', id) from public.projects where id = p
$$;

-- Project + financials + team + the default folders + history. Members: [{"user": uuid, "role": "..."}].
create function private.demo_sg_project(
  p_co uuid, p_code text, p_name text, p_client text, p_phone text, p_email text, p_site text, p_lat numeric, p_lng numeric,
  p_start date, p_end date, p_status public.project_status, p_color text, p_lead uuid, p_by uuid, p_created date,
  p_area numeric, p_rate numeric, p_value numeric, p_members jsonb
) returns uuid language plpgsql as $$
declare
  v uuid := gen_random_uuid();
  t timestamptz := private.demo_sg_at(p_created, 12);
  m jsonb;
begin
  insert into public.projects (id, company_id, lead_id, code, name, client_name, client_phone, client_email, site_address, site_lat, site_lng,
    start_date, end_date, original_end_date, status, color, created_by, created_at, updated_at)
  values (v, p_co, p_lead, p_code, p_name, p_client, p_phone, p_email, p_site, p_lat, p_lng, p_start, p_end, p_end, p_status, p_color, p_by, t, t);
  insert into public.project_financials (project_id, area_sqft, rate_per_sqft, contract_value, updated_at, updated_by)
  values (v, p_area, p_rate, p_value, t, p_by);
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (v, p_by, 'project_created', jsonb_build_object('lead_id', p_lead, 'start', p_start, 'end', p_end, 'phases', 9), t);
  for m in select * from jsonb_array_elements(p_members) loop
    insert into public.project_members (project_id, user_id, member_role, added_by, added_at)
    values (v, (m ->> 'user')::uuid, (m ->> 'role')::public.project_member_role, p_by, t);
    insert into public.project_activities (project_id, actor_id, type, meta, created_at)
    values (v, p_by, 'member_added', jsonb_build_object('name', private.demo_sg_name((m ->> 'user')::uuid), 'role', m ->> 'role'), t + interval '1 minute');
  end loop;
  insert into public.project_folders (project_id, name, system_key, restricted, position, created_by, created_at)
  values (v, 'Site images', 'site_images', false, 1, p_by, t), (v, 'Layout & deck', 'layout_deck', false, 2, p_by, t),
    (v, 'BOQ', 'boq', false, 3, p_by, t), (v, 'GFC drawings (DWG)', 'gfc', false, 4, p_by, t),
    (v, '3D / SketchUp', 'three_d', false, 5, p_by, t), (v, 'Execution photos', 'execution_photos', false, 6, p_by, t),
    (v, 'Handover', 'handover', false, 7, p_by, t), (v, 'Payment proofs', 'payment_proofs', true, 8, p_by, t);
  if p_lead is not null then
    insert into public.lead_activities (lead_id, actor_id, type, meta, created_at)
    values (p_lead, p_by, 'project_created', jsonb_build_object('project_id', v, 'name', p_name), t);
  end if;
  return v;
end $$;

-- One phase status change in the history (what the phase trigger logs in the app).
create function private.demo_sg_status(p_project uuid, p_phase uuid, p_name text, p_from text, p_to text, p_by uuid, p_at timestamptz, p_deadline date, p_sub date)
returns void language sql as $$
  insert into public.project_activities (project_id, actor_id, type, phase_id, meta, created_at)
  values (p_project, p_by, 'phase_status_changed', p_phase,
    jsonb_build_object('phase', p_name, 'from', p_from, 'to', p_to, 'deadline', p_deadline, 'submitted_on', p_sub), p_at)
$$;

-- The Star Gardens template spread over start..end. p_states has one letter per phase:
-- D done, L done late (by p_late days), R in review, C changes requested, P in progress, N not started, S skipped.
create function private.demo_sg_timeline(p_project uuid, p_start date, p_end date, p_states text, p_owner uuid, p_by uuid, p_late integer default 0)
returns void language plpgsql as $$
declare
  cats text[] := array['Design', 'Design', 'Design', 'GFC drawings', 'GFC drawings', 'Execution', 'Execution', 'Execution', 'Finish'];
  names text[] := array['First cut design & estimation — R0', 'Design development: layout + deck', 'BOQ — R2', 'GFC drawings',
    'BOQ — R3 (hardscape + softscape)', 'Kick-off meeting at site', 'Execution', 'BOQ — R4 (final)', 'Handover & completion report'];
  colors text[] := array['sky', 'sky', 'violet', 'blue', 'violet', 'amber', 'orange', 'violet', 'emerald'];
  weights integer[] := array[6, 14, 7, 15, 5, 2, 40, 4, 7];
  client_ok boolean[] := array[false, true, true, true, true, false, false, true, false];
  items jsonb := '{"2": ["Detailed layout", "Updated pitch / design deck"], "3": ["Detailed BOQ from approved layout"],
    "4": ["Master plan", "Grading plan", "Drainage plan", "Lighting plan", "Setting out plan", "Planting plan"],
    "6": ["Confirm drawings, materials and quantities", "Brief the execution team"], "8": ["Approved changes during execution"],
    "9": ["Final site inspection", "Rectify snags", "Completion report", "Handover to client"]}';
  total integer := p_end - p_start + 1;
  cursor_d integer := 0;
  len integer; s char; st public.phase_status; ph uuid; ps date; dl date; sub date; act date; k integer; n_items integer;
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  for i in 1 .. 9 loop
    len := case when i = 9 then greatest(total - cursor_d, 1) else greatest(1, least(round(weights[i] * total / 100.0)::int, total - cursor_d - (9 - i))) end;
    ps := p_start + least(cursor_d, total - 1);
    dl := case when i = 9 then p_end else least(ps + len - 1, p_end) end;
    cursor_d := cursor_d + len;
    s := substr(p_states, i, 1);
    st := case s when 'D' then 'done' when 'L' then 'done' when 'R' then 'in_review' when 'C' then 'changes_requested'
      when 'P' then 'in_progress' when 'S' then 'skipped' else 'not_started' end;
    act := case when s in ('D', 'L', 'R', 'C', 'P') then ps end;
    sub := case when s = 'D' then greatest(dl - (i % 2), ps) when s = 'L' then dl + p_late when s in ('R', 'C') then greatest(least(today, dl + p_late), ps) end;
    ph := gen_random_uuid();
    insert into public.project_phases (id, project_id, position, category, name, color, owner_id, planned_start, deadline, actual_start,
      submitted_on, status, needs_client_approval, created_by, created_at, updated_at)
    values (ph, p_project, i, cats[i], names[i], colors[i], p_owner, ps, dl, act, sub, st, client_ok[i], p_by,
      private.demo_sg_at(p_start - 1), private.demo_sg_at(coalesce(sub, act, p_start - 1), 15));
    n_items := coalesce(jsonb_array_length(items -> i::text), 0);
    for k in 1 .. n_items loop
      insert into public.project_phase_items (phase_id, position, title, done_at, done_by, created_by, created_at)
      values (ph, k, items -> i::text ->> (k - 1),
        case when s in ('D', 'L', 'R') or (s in ('P', 'C') and k <= n_items / 2) then private.demo_sg_at(coalesce(sub, today), 10) end,
        case when s in ('D', 'L', 'R') or (s in ('P', 'C') and k <= n_items / 2) then p_owner end,
        p_by, private.demo_sg_at(p_start - 1));
    end loop;
    -- Status history, as the app writes it: the owner starts and submits, the admin approves or asks for changes.
    if s = 'S' then
      perform private.demo_sg_status(p_project, ph, names[i], 'not_started', 'skipped', p_by, private.demo_sg_at(ps, 10), dl, null);
    elsif s <> 'N' then
      perform private.demo_sg_status(p_project, ph, names[i], 'not_started', 'in_progress', coalesce(p_owner, p_by), private.demo_sg_at(act, 10), dl, null);
      if s = 'L' then
        perform private.demo_sg_status(p_project, ph, names[i], 'in_progress', 'in_review', coalesce(p_owner, p_by), private.demo_sg_at(greatest(act, dl - 2), 16), dl, greatest(act, dl - 2));
        perform private.demo_sg_status(p_project, ph, names[i], 'in_review', 'changes_requested', p_by, private.demo_sg_at(greatest(act, dl - 2), 18), dl, greatest(act, dl - 2));
        perform private.demo_sg_status(p_project, ph, names[i], 'changes_requested', 'in_progress', coalesce(p_owner, p_by), private.demo_sg_at(greatest(act, dl - 1), 10), dl, null);
      end if;
      if s in ('D', 'L', 'R', 'C') then
        perform private.demo_sg_status(p_project, ph, names[i], 'in_progress', 'in_review', coalesce(p_owner, p_by), private.demo_sg_at(sub, 17), dl, sub);
      end if;
      if s = 'C' then
        perform private.demo_sg_status(p_project, ph, names[i], 'in_review', 'changes_requested', p_by, private.demo_sg_at(sub, 19), dl, sub);
      elsif s in ('D', 'L') then
        perform private.demo_sg_status(p_project, ph, names[i], 'in_review', 'done', p_by, private.demo_sg_at(least(sub + 1, today), 11), dl, sub);
      end if;
    end if;
  end loop;
end $$;

-- A folder by path: "site_images" (system key) or "Site images/Before/Week 1" (names, case-insensitive). Missing
-- folders below the first one are created as custom folders.
create function private.demo_sg_folder(p_project uuid, p_path text, p_by uuid) returns uuid
language plpgsql as $$
declare
  seg text; f uuid; parent uuid; is_top boolean := true;
begin
  foreach seg in array string_to_array(p_path, '/') loop
    seg := btrim(seg);
    select id into f from public.project_folders
    where project_id = p_project and archived_at is null and parent_id is not distinct from parent
      and (lower(name) = lower(seg) or (is_top and system_key = seg));
    if f is null then
      f := gen_random_uuid();
      insert into public.project_folders (id, project_id, parent_id, name, position, created_by, created_at)
      values (f, p_project, parent, seg,
        (select coalesce(max(position), 0) + 1 from public.project_folders where project_id = p_project and parent_id is not distinct from parent),
        p_by, (select created_at from public.projects where id = p_project) + interval '1 day');
    end if;
    parent := f; f := null; is_top := false;
  end loop;
  return parent;
end $$;

-- A file with its versions. p_versions: [{"status": "...", "days": 12, "size": 123, "note": "...", "client_comment": "...", "by": uuid}]
-- (oldest first; "by" = who approved / asked for changes). Placeholder bytes are uploaded by the seed script.
create function private.demo_sg_file(p_project uuid, p_folder text, p_name text, p_kind text, p_ext text, p_mime text, p_by uuid,
  p_versions jsonb, p_phase uuid default null, p_payment uuid default null, p_archived boolean default false)
returns uuid language plpgsql as $$
declare
  f uuid := gen_random_uuid(); v uuid; x jsonb; n integer := 0; t timestamptz; first_t timestamptz; st text; who uuid;
begin
  first_t := now() - ((p_versions -> 0 ->> 'days')::numeric * interval '1 day');
  insert into public.project_files (id, project_id, folder_id, name, kind, phase_id, payment_id, created_by, created_at, updated_at, archived_at, archived_by)
  values (f, p_project, private.demo_sg_folder(p_project, p_folder, p_by), p_name, p_kind,
    p_phase, p_payment, p_by, first_t, first_t, case when p_archived then now() - interval '1 day' end, case when p_archived then p_by end);
  for x in select * from jsonb_array_elements(p_versions) loop
    n := n + 1;
    v := gen_random_uuid();
    t := now() - ((x ->> 'days')::numeric * interval '1 day');
    st := x ->> 'status';
    who := nullif(x ->> 'by', '')::uuid;
    insert into public.project_file_versions (id, file_id, project_id, version_no, storage_path, original_name, size_bytes, mime_type, note,
      status, status_by, status_at, client_comment, uploaded_by, created_at)
    values (v, f, p_project, n, p_project || '/' || v || '.' || p_ext, p_name, coalesce((x ->> 'size')::bigint, 48213), p_mime, x ->> 'note',
      st, case when st <> 'draft' then coalesce(who, p_by) end, case when st <> 'draft' then t + interval '2 hours' end, x ->> 'client_comment', p_by, t);
    insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, comment, created_at)
    values (p_project, f, v, 'uploaded', p_by, x ->> 'note', t);
    if st <> 'draft' then
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, created_at)
      values (p_project, f, v, 'submitted', p_by, t + interval '1 hour');
    end if;
    if st in ('approved', 'client_approved', 'superseded') or (st = 'changes_requested' and x ->> 'client_comment' is not null) then
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, created_at)
      values (p_project, f, v, 'approved', coalesce(who, p_by), t + interval '2 hours');
    elsif st = 'changes_requested' then
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, comment, created_at)
      values (p_project, f, v, 'changes_requested', coalesce(who, p_by), x ->> 'note', t + interval '2 hours');
    end if;
    if st = 'superseded' then
      insert into public.project_file_events (project_id, file_id, version_id, type, actor_id, created_at)
      values (p_project, f, v, 'superseded', p_by, now() - ((p_versions -> n ->> 'days')::numeric * interval '1 day'));
    end if;
  end loop;
  update public.project_files set current_version_id = v, updated_at = t where id = f;
  return f;
end $$;

-- ----- the data -------------------------------------------------------------
do $$
declare
  co uuid;
  today date := (now() at time zone 'Asia/Kolkata')::date;
  adm uuid; bdm1 uuid; bdm2 uuid; am1 uuid; am2 uuid; ld1 uuid; ld2 uuid; ld3 uuid; ex1 uuid; acc uuid;
  ly integer := extract(year from (now() at time zone 'Asia/Kolkata'))::int - 1; -- last year
  next_m date := (date_trunc('month', now() at time zone 'Asia/Kolkata') + interval '1 month')::date;
  open_st uuid[]; open_names text[]; won_st uuid; won_name text; lost_st uuid; lost_name text;
  nv uuid := gen_random_uuid(); na uuid := gen_random_uuid(); nc uuid := gen_random_uuid(); nf uuid := gen_random_uuid();
  lead jsonb := '{}';
  r record;
  v_id uuid; v_owner uuid; v_stage uuid; v_kind public.lead_outcome; v_t timestamptz;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid; p7 uuid; p8 uuid; p9 uuid; p10 uuid; p11 uuid; p12 uuid; p13 uuid;
  m1 uuid; m2 uuid; m3 uuid; m4 uuid; pay uuid; rev uuid;
  ph uuid;
begin
  select id into co from public.companies where normalized_name = 'star gardens' and archived_at is null;
  if co is null then
    raise exception 'No active company named "Star Gardens".';
  end if;
  if to_regclass('public.project_file_events') is null or not exists (
    select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_payments' and column_name = 'is_extra')
    or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'original_end_date')
    or to_regprocedure('private.can_nest_project_folder(uuid,uuid)') is null
    or to_regprocedure('public.project_months(text,boolean)') is null
    or to_regclass('public.app_notifications') is null or to_regclass('public.project_folder_colors') is null then
    raise exception 'Apply all project migrations first (20261008000100–20261008001600).';
  end if;
  if exists (select 1 from public.projects where company_id = co and code like 'SG-DEMO-%') then
    raise exception 'The Star Gardens demo data is already there. Remove it first: pnpm seed:star-gardens --clean';
  end if;
  select id into adm from public.profiles where username = 'demo_sg_admin';
  select id into bdm1 from public.profiles where username = 'demo_sg_bdm1';
  select id into bdm2 from public.profiles where username = 'demo_sg_bdm2';
  select id into am1 from public.profiles where username = 'demo_sg_am1';
  select id into am2 from public.profiles where username = 'demo_sg_am2';
  select id into ld1 from public.profiles where username = 'demo_sg_ld1';
  select id into ld2 from public.profiles where username = 'demo_sg_ld2';
  select id into ld3 from public.profiles where username = 'demo_sg_ld3';
  select id into ex1 from public.profiles where username = 'demo_sg_ex1';
  select id into acc from public.profiles where username = 'demo_sg_acc';
  if num_nulls(adm, bdm1, bdm2, am1, am2, ld1, ld2, ld3, ex1, acc) > 0 then
    raise exception 'Create the demo_sg_* users first (scripts/seed-star-gardens.mjs does).';
  end if;

  select array_agg(id order by position), array_agg(name order by position) into open_st, open_names
  from public.pipeline_stages where company_id = co and kind = 'open' and archived_at is null;
  select id, name into won_st, won_name from public.pipeline_stages where company_id = co and kind = 'won' and archived_at is null order by position limit 1;
  select id, name into lost_st, lost_name from public.pipeline_stages where company_id = co and kind = 'lost' and archived_at is null order by position limit 1;

  -- ----- niches ---------------------------------------------------------------
  insert into public.niches (id, company_id, name, created_by, created_at, updated_at) values
    (nv, co, 'Demo SG Villas & Independent Houses', bdm1, now() - interval '200 days', now() - interval '200 days'),
    (na, co, 'Demo SG Apartments', bdm1, now() - interval '200 days', now() - interval '200 days'),
    (nc, co, 'Demo SG Commercial / Tech Parks', bdm2, now() - interval '200 days', now() - interval '200 days'),
    (nf, co, 'Demo SG Farmhouses', bdm1, now() - interval '200 days', now() - interval '200 days');

  -- ----- leads ----------------------------------------------------------------
  -- stage: o1..o4 = the open stages in order (Inquiry, Pitch, Negotiation, On hold), won, lost.
  for r in select * from jsonb_to_recordset('[
    {"k": "hari", "name": "Demo Mr. Hari Prasad", "phone": "+919840011001", "email": "hari.demo@example.com", "niche": "v", "stage": "won", "owner": "bdm1", "days": 40, "handoff": 30, "note": "Wants a pergola near the pool, 65 × 12 ft lawn. Budget about ₹8 lakh."},
    {"k": "villa", "name": "Demo Villa Greens (Mrs. Kavya Menon)", "phone": "+919840011002", "email": null, "niche": "v", "stage": "won", "owner": "bdm1", "days": 95, "handoff": 82, "note": "Big villa on ECR. Very particular about the entrance."},
    {"k": "sunrise", "name": "Demo Sunrise Apartments Association", "phone": "+919840011004", "email": "secretary.demo@example.com", "niche": "a", "stage": "won", "owner": "bdm1", "days": 180, "handoff": 170, "note": "Terrace garden for 120 flats."},
    {"k": "farm", "name": "Demo Mr. Joseph (Farmhouse)", "phone": "+919840011005", "email": null, "niche": "f", "stage": "won", "owner": "bdm2", "days": 70, "handoff": 60, "note": "Weekend farmhouse, wants a natural pond."},
    {"k": "cafe", "name": "Demo Rooftop Café ☕ Bloom", "phone": "+919840011006", "email": "bloom.demo@example.com", "niche": "c", "stage": "won", "owner": "bdm1", "days": 60, "handoff": 50, "note": null},
    {"k": "next", "name": "Demo Dr. Ramaswamy (MBBS, MD)", "phone": "+919840011007", "email": null, "niche": "v", "stage": "won", "owner": "bdm1", "days": 12, "handoff": 8, "note": "Starts after Diwali."},
    {"k": "tamil", "name": "ஸ்ரீ லக்ஷ்மி கார்டன்ஸ் — Demo", "phone": "+919840011008", "email": null, "niche": "v", "stage": "won", "owner": "bdm1", "days": 50, "handoff": 45, "note": "பெரிய தோட்டம் வேண்டும். Prefers calls after 6 PM."},
    {"k": "archived", "name": "Demo Test Lead (project archived)", "phone": "+919840011009", "email": null, "niche": "a", "stage": "won", "owner": "bdm1", "days": 30, "handoff": 29, "note": "Created by mistake."},
    {"k": "wait1", "name": "Demo Mrs. Ananya Iyer", "phone": "+919840011010", "email": "ananya.demo@example.com", "niche": "v", "stage": "o3", "owner": "bdm1", "days": 9, "handoff": 0, "note": "Saw our Instagram reel. Wants the same vertical garden. Site visit done."},
    {"k": "wait2", "name": "Demo Prestige Lakeside Clubhouse", "phone": "+919840011011", "email": "facilities.demo@example.com", "niche": "c", "stage": "o3", "owner": "bdm2", "days": 25, "handoff": 11, "note": "Handed over 11 days ago and still waiting for a project: check the reminder."},
    {"k": "wait3", "name": "Demo Mr. Imran Khan", "phone": "+971501234567", "email": null, "niche": "v", "stage": "o2", "owner": "bdm1", "days": 6, "handoff": 2, "note": "Lives in Dubai, the house is in Chennai. Calls on WhatsApp only."},
    {"k": "pitch1", "name": "Demo Green Valley School", "phone": "+919840011013", "email": "principal.demo@example.com", "niche": "c", "stage": "o2", "owner": "bdm1", "days": 14, "handoff": null, "note": null},
    {"k": "pitch2", "name": "Demo Mr. Suresh Reddy", "phone": "+919840011014", "email": null, "niche": "v", "stage": "o2", "owner": "bdm1", "days": 3, "handoff": null, "note": "Deck sent on WhatsApp."},
    {"k": "inq1", "name": "Demo Ms. Fatima", "phone": "+919840011015", "email": null, "niche": "a", "stage": "o1", "owner": "bdm1", "days": 0, "handoff": null, "note": null},
    {"k": "inq2", "name": "Demo Duplicate Phone (1 of 2)", "phone": "+919840011099", "email": null, "niche": "v", "stage": "o1", "owner": "bdm1", "days": 2, "handoff": null, "note": null},
    {"k": "inq3", "name": "Demo Duplicate Phone (2 of 2)", "phone": "+919840011099", "email": null, "niche": "v", "stage": "o1", "owner": "bdm2", "days": 1, "handoff": null, "note": "Same number as another lead."},
    {"k": "hold", "name": "Demo Mr. Vikram (on hold)", "phone": "+919840011016", "email": null, "niche": "f", "stage": "o4", "owner": "bdm1", "days": 45, "handoff": null, "note": "Waiting for the bank loan."},
    {"k": "lost1", "name": "Demo Lost — went with a cheaper vendor", "phone": "+919840011017", "email": null, "niche": "a", "stage": "lost", "owner": "bdm1", "days": 60, "handoff": null, "note": "Lost on price (they got ₹180/sq ft elsewhere)."},
    {"k": "lost2", "name": "Demo Lost after handover", "phone": "+919840011018", "email": null, "niche": "v", "stage": "lost", "owner": "bdm2", "days": 40, "handoff": 35, "note": "Client cancelled before we created the project."},
    {"k": "lastyear", "name": "Demo Lakeview Resort, Kodaikanal", "phone": "+919840011020", "email": "gm.lakeview.demo@example.com", "niche": "c", "stage": "won", "owner": "bdm2", "days": 420, "handoff": 360, "note": "Hill-slope garden; work stops in the monsoon."},
    {"k": "newyear", "name": "Demo Mrs. Deepa Nair", "phone": "+919840011021", "email": null, "niche": "v", "stage": "won", "owner": "bdm1", "days": 330, "handoff": 300, "note": "Wants it done before Pongal."},
    {"k": "nextmonth", "name": "Demo Olive Tree Montessori", "phone": "+919840011022", "email": "admin.olive.demo@example.com", "niche": "c", "stage": "won", "owner": "bdm1", "days": 21, "handoff": 12, "note": "Play garden; school holidays next month."},
    {"k": "nextcancel", "name": "Demo Mr. Prakash (cancelled before start)", "phone": "+919840011023", "email": null, "niche": "f", "stage": "won", "owner": "bdm1", "days": 26, "handoff": 16, "note": "Signed, then sold the land."},
    {"k": "long", "name": "Demo Sri Venkateswara Residency Phase II Owners Welfare Association Landscape & Terrace Garden Committee", "phone": "+919840011019", "email": null, "niche": "a", "stage": "o1", "owner": "bdm1", "days": 4, "handoff": null, "note": null}
  ]'::jsonb) as x(k text, name text, phone text, email text, niche text, stage text, owner text, days integer, handoff integer, note text)
  loop
    v_id := gen_random_uuid();
    v_owner := case r.owner when 'bdm2' then bdm2 else bdm1 end;
    v_stage := case r.stage when 'won' then won_st when 'lost' then lost_st else open_st[substr(r.stage, 2)::int] end;
    v_kind := case r.stage when 'won' then 'won' when 'lost' then 'lost' else 'open' end;
    v_t := now() - r.days * interval '1 day' - interval '3 hours';
    insert into public.leads (id, company_id, name, phone, phone_normalized, email, niche_id, stage_id, status, owner_id, created_by,
      handoff_at, handoff_by, handoff_note, created_at, updated_at)
    values (v_id, co, r.name, r.phone, r.phone, r.email,
      case r.niche when 'v' then nv when 'a' then na when 'c' then nc else nf end, v_stage, v_kind, v_owner, v_owner,
      case when r.handoff is not null then now() - r.handoff * interval '1 day' end, case when r.handoff is not null then v_owner end,
      case when r.handoff is not null then r.note end, v_t, now() - least(r.days, coalesce(r.handoff, r.days)) * interval '1 day');
    insert into public.lead_activities (lead_id, actor_id, type, meta, created_at)
    values (v_id, v_owner, 'lead_created', jsonb_build_object('status', open_names[1], 'stage_id', open_st[1], 'owner', private.demo_sg_name(v_owner)), v_t);
    if v_stage <> open_st[1] then
      insert into public.lead_activities (lead_id, actor_id, type, meta, created_at)
      values (v_id, v_owner, 'status_changed', jsonb_build_object(
        'from', open_names[1], 'to', case r.stage when 'won' then won_name when 'lost' then lost_name else open_names[substr(r.stage, 2)::int] end,
        'from_kind', 'open', 'to_kind', v_kind, 'from_stage_id', open_st[1], 'to_stage_id', v_stage),
        now() - greatest(coalesce(r.handoff, 0), r.days / 2) * interval '1 day');
    end if;
    if r.note is not null and r.handoff is null then
      insert into public.lead_activities (lead_id, actor_id, type, body, created_at) values (v_id, v_owner, 'note', r.note, v_t + interval '1 hour');
    end if;
    if r.handoff is not null then
      insert into public.lead_activities (lead_id, actor_id, type, body, created_at)
      values (v_id, v_owner, 'handed_off', r.note, now() - r.handoff * interval '1 day');
    end if;
    lead := lead || jsonb_build_object(r.k, v_id);
  end loop;

  -- Follow-ups for the BDMs: one overdue, one today, one done.
  insert into public.follow_ups (lead_id, assignee_id, created_by, due_at, task, state, completed_at, completed_by, outcome, created_at) values
    ((lead ->> 'pitch1')::uuid, bdm1, bdm1, private.demo_sg_at(today - 2, 11), 'Call the principal about the deck', 'pending', null, null, null, now() - interval '5 days'),
    ((lead ->> 'pitch2')::uuid, bdm1, bdm1, private.demo_sg_at(today, 17), 'Ask if the deck opened fine', 'pending', null, null, null, now() - interval '2 days'),
    ((lead ->> 'wait1')::uuid, bdm1, bdm1, private.demo_sg_at(today - 8, 10), 'Book the site visit', 'completed', private.demo_sg_at(today - 8, 12), bdm1, 'Visit booked with Raj', now() - interval '9 days');

  -- ======================================================================
  -- P1  Mr. Hari Residence — on track, design in review, advance paid, client portal with files.
  -- ======================================================================
  p1 := private.demo_sg_project(co, 'SG-DEMO-01', 'Demo — Mr. Hari Residence', 'Mr. Hari Prasad', '+919840011001', 'hari.demo@example.com',
    '12, 3rd Cross Street, Besant Nagar, Chennai 600090', 13.000215, 80.266479, today - 28, today + 60, 'active', 'emerald',
    (lead ->> 'hari')::uuid, adm, today - 29, 780, 1000, 780000,
    jsonb_build_array(jsonb_build_object('user', am1, 'role', 'architect_manager'), jsonb_build_object('user', ld1, 'role', 'landscape_designer')));
  perform private.demo_sg_timeline(p1, today - 28, today + 60, 'DRPNNNNNN', ld1, adm);
  update public.project_phases set notes = private.demo_sg_doc('Client wants a pergola near the pool and low-maintenance lawn.', 'Brief:', 'Avoid thorny plants — small kids at home.'),
    remark = 'Client meeting on Saturday'
  where project_id = p1 and position = 2;
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, phase_id, created_by, created_at, updated_at) values
    (gen_random_uuid(), p1, 1, 'Advance', 30, 234000, 'date', today - 28, null, adm, private.demo_sg_at(today - 29), private.demo_sg_at(today - 29)),
    (gen_random_uuid(), p1, 2, 'After design approval', 20, 156000, 'phase', null, (select id from public.project_phases where project_id = p1 and position = 2), adm, private.demo_sg_at(today - 29), private.demo_sg_at(today - 29)),
    (gen_random_uuid(), p1, 3, 'After BOQ R2', 30, 234000, 'phase', null, (select id from public.project_phases where project_id = p1 and position = 3), adm, private.demo_sg_at(today - 29), private.demo_sg_at(today - 29)),
    (gen_random_uuid(), p1, 4, 'At handover', 20, 156000, 'phase', null, (select id from public.project_phases where project_id = p1 and position = 9), adm, private.demo_sg_at(today - 29), private.demo_sg_at(today - 29));
  select id into m1 from public.project_payment_milestones where project_id = p1 and position = 1;
  -- Advance paid in two parts (UPI + bank transfer) = fully paid.
  pay := gen_random_uuid();
  insert into public.project_payments (id, project_id, milestone_id, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at) values
    (pay, p1, m1, 100000, today - 27, 'upi', 'UPI/4567 1234 8890', acc, 'First part of the advance', acc, private.demo_sg_at(today - 27), private.demo_sg_at(today - 27)),
    (gen_random_uuid(), p1, m1, 134000, today - 20, 'bank_transfer', 'UTR HDFC0000123456789', acc, null, acc, private.demo_sg_at(today - 20), private.demo_sg_at(today - 20));
  -- Files: every status.
  perform private.demo_sg_file(p1, 'layout_deck', 'Layout plan.pdf', 'pdf', 'pdf', 'application/pdf', ld1, jsonb_build_array(
    jsonb_build_object('status', 'superseded', 'days', 18, 'size', 2400000, 'note', 'First layout', 'by', am1,
      'client_comment', 'Please move the pergola closer to the pool.'),
    jsonb_build_object('status', 'client_approved', 'days', 9, 'size', 2650000, 'note', 'Pergola moved, more shade trees', 'by', am1)),
    (select id from public.project_phases where project_id = p1 and position = 2));
  perform private.demo_sg_file(p1, 'layout_deck', 'Concept deck.pdf', 'pdf', 'pdf', 'application/pdf', ld1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 3, 'size', 8900000, 'by', am1)));
  perform private.demo_sg_file(p1, 'site_images', 'Site photo — front lawn.png', 'image', 'png', 'image/png', am1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 26, 'size', 3100000, 'by', am1)));
  perform private.demo_sg_file(p1, 'site_images', 'Site photo — backyard.png', 'image', 'png', 'image/png', am1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 26, 'size', 2800000, 'by', am1)));
  perform private.demo_sg_file(p1, 'gfc', 'Planting plan.dwg', 'cad', 'dwg', 'image/vnd.dwg', ld1, jsonb_build_array(
    jsonb_build_object('status', 'draft', 'days', 1, 'size', 14500000, 'note', 'Work in progress — not for the client')));
  perform private.demo_sg_file(p1, 'three_d', '3D view.skp', 'sketchup', 'skp', 'application/vnd.sketchup.skp', ld1, jsonb_build_array(
    jsonb_build_object('status', 'submitted', 'days', 0.2, 'size', 96000000, 'note', 'Please review the night lighting')));
  perform private.demo_sg_file(p1, 'gfc', 'Lighting layout.pdf', 'pdf', 'pdf', 'application/pdf', ld1, jsonb_build_array(
    jsonb_build_object('status', 'changes_requested', 'days', 2, 'size', 1200000, 'by', am1, 'note', 'Bollards are too close to the path')));
  perform private.demo_sg_file(p1, 'payment_proofs', 'Advance UPI screenshot.png', 'image', 'png', 'image/png', acc, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 27, 'size', 180000, 'by', acc)), null, pay);
  perform private.demo_sg_file(p1, 'site_images', 'Old sketch (removed).png', 'image', 'png', 'image/png', ld1, jsonb_build_array(
    jsonb_build_object('status', 'draft', 'days', 25, 'size', 90000)), null, null, true);
  -- Pin notes on the approved layout: one open, one resolved.
  insert into public.project_file_comments (version_id, project_id, page, x_pct, y_pct, body, author_id, created_at, resolved_at, resolved_by)
  select v.id, p1, 1, 62.5, 40.2, 'Use Bermuda grass here, not Korean — full sun.', am1, now() - interval '8 days', null, null
  from public.project_file_versions v join public.project_files f on f.id = v.file_id where f.project_id = p1 and f.name = 'Layout plan.pdf' and v.version_no = 2
  union all
  select v.id, p1, 1, 20, 75, 'Gate width is 12 ft, not 10 ft.', ld1, now() - interval '9 days', now() - interval '8 days', ld1
  from public.project_file_versions v join public.project_files f on f.id = v.file_id where f.project_id = p1 and f.name = 'Layout plan.pdf' and v.version_no = 2;
  -- Site visits: first visit done (close to the pin), next one tomorrow.
  insert into public.site_visits (company_id, project_id, assigned_to, scheduled_at, purpose, status, check_in_at, check_in_lat, check_in_lng,
    check_in_accuracy_m, distance_from_site_m, check_out_at, notes, measurements, outcome, created_by, created_at, updated_at) values
    (co, p1, am1, private.demo_sg_at(today - 27, 10), 'Measurements and soil check', 'completed', private.demo_sg_at(today - 27, 10) + interval '12 minutes',
      13.000500, 80.266300, 8, 35, private.demo_sg_at(today - 27, 11) + interval '40 minutes',
      private.demo_sg_doc('Soil is clayey near the back wall; needs drainage.', 'Soil:'), 'Front lawn 65 × 12 ft; backyard 30 × 20 ft; pool deck 18 × 10 ft',
      'Client OK with the pergola position', adm, private.demo_sg_at(today - 29), private.demo_sg_at(today - 27, 12)),
    (co, p1, am1, private.demo_sg_at(today + 1, 16), 'Show the layout on site', 'scheduled', null, null, null, null, null, null, null, null, null, adm, now() - interval '1 day', now() - interval '1 day');
  insert into public.project_activities (project_id, actor_id, type, body, created_at)
  values (p1, am1, 'note', 'Client asked for a quote for outdoor lighting separately.', now() - interval '6 days');

  -- ======================================================================
  -- P2  Villa Greens — late: overdue phases, parallel phases, a phase past the end date, overdue payments.
  -- ======================================================================
  p2 := private.demo_sg_project(co, 'SG-DEMO-02', 'Demo — Villa Greens, ECR', 'Mrs. Kavya Menon', '+919840011002', null,
    'Plot 44, Sea Breeze Avenue, Uthandi, ECR, Chennai', 12.866100, 80.246800, today - 80, today + 12, 'active', 'red',
    (lead ->> 'villa')::uuid, adm, today - 81, 4200, 650, 2730000,
    jsonb_build_array(jsonb_build_object('user', am2, 'role', 'architect_manager'), jsonb_build_object('user', ld1, 'role', 'landscape_designer'),
      jsonb_build_object('user', ld2, 'role', 'landscape_designer'), jsonb_build_object('user', ex1, 'role', 'execution')));
  perform private.demo_sg_timeline(p2, today - 80, today + 12, 'LLCPPNNNN', ld2, adm, 9);
  -- Extended: planned to end 8 days ago, moved out by 20 days.
  update public.projects set original_end_date = today - 8 where id = p2;
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (p2, adm, 'project_updated', jsonb_build_object('changes', jsonb_build_object('End', jsonb_build_object('from', today - 8, 'to', today + 12))), now() - interval '14 days');
  -- Parallel: GFC drawings and BOQ R3 run together; GFC is overdue; BOQ R4 deadline is after the project end (at risk).
  update public.project_phases set planned_start = today - 40, deadline = today - 12, owner_id = ld1 where project_id = p2 and position = 4;
  update public.project_phases set planned_start = today - 38, deadline = today - 5 where project_id = p2 and position = 5;
  update public.project_phases set planned_start = today + 5, deadline = today + 25, remark = 'Ends after the project end date' where project_id = p2 and position = 8;
  update public.project_phases set owner_id = null, remark = 'Nobody assigned yet' where project_id = p2 and position = 6;
  update public.project_phases set notes = private.demo_sg_doc('Client wants the entrance redone with granite, not pebbles.', 'Changes:', 'Third round of changes — talk about extra charges.')
  where project_id = p2 and position = 3;
  insert into public.project_activities (project_id, actor_id, type, phase_id, meta, created_at)
  select p2, am2, 'phase_rescheduled', id, jsonb_build_object('phase', name, 'from', jsonb_build_object('start', today - 45, 'deadline', today - 20),
    'to', jsonb_build_object('start', today - 40, 'deadline', today - 12)), now() - interval '25 days'
  from public.project_phases where project_id = p2 and position = 4;
  -- Schedule adds up to 90% only (the app warns). ₹5.5 lakh paid against a ₹8.19 lakh advance: partly paid and overdue,
  -- the rest stays due. One payment was entered twice and removed (archived).
  m2 := gen_random_uuid();
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, phase_id, notes, created_by, created_at, updated_at) values
    (m2, p2, 1, 'Advance', 30, 819000, 'date', today - 78, null, null, acc, private.demo_sg_at(today - 81), private.demo_sg_at(today - 81)),
    (gen_random_uuid(), p2, 2, 'After design approval', 20, 546000, 'date', today - 30, null, 'Design was approved on WhatsApp', acc, private.demo_sg_at(today - 81), private.demo_sg_at(today - 31)),
    (gen_random_uuid(), p2, 3, 'After BOQ R2', 40, 1092000, 'phase', null, (select id from public.project_phases where project_id = p2 and position = 3), null, acc, private.demo_sg_at(today - 81), private.demo_sg_at(today - 81));
  insert into public.project_payments (project_id, milestone_id, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at, archived_at, archived_by) values
    (p2, m2, 500000, today - 76, 'cheque', 'Cheque 004512 (ICICI)', acc, 'Balance promised next week', acc, private.demo_sg_at(today - 76), private.demo_sg_at(today - 76), null, null),
    (p2, m2, 50000, today - 60, 'cash', null, adm, 'Entered twice by mistake', adm, private.demo_sg_at(today - 60), private.demo_sg_at(today - 59), private.demo_sg_at(today - 59), acc),
    (p2, m2, 50000, today - 60, 'cash', 'Cash receipt #18', adm, null, adm, private.demo_sg_at(today - 60), private.demo_sg_at(today - 60), null, null);
  perform private.demo_sg_file(p2, 'layout_deck', 'Entrance layout.pdf', 'pdf', 'pdf', 'application/pdf', ld2, jsonb_build_array(
    jsonb_build_object('status', 'superseded', 'days', 50, 'by', am2),
    jsonb_build_object('status', 'superseded', 'days', 35, 'by', am2),
    jsonb_build_object('status', 'changes_requested', 'days', 15, 'by', am2, 'client_comment', 'Granite instead of pebbles at the entrance, and a bigger name board.')));
  perform private.demo_sg_file(p2, 'gfc', 'Drainage plan.dwg', 'cad', 'dwg', 'image/vnd.dwg', ld1, jsonb_build_array(
    jsonb_build_object('status', 'submitted', 'days', 4, 'size', 22000000)));
  insert into public.site_visits (company_id, project_id, assigned_to, scheduled_at, purpose, status, check_in_at, check_in_lat, check_in_lng,
    check_in_accuracy_m, distance_from_site_m, check_out_at, outcome, created_by, created_at, updated_at) values
    -- Checked in 1.8 km from the site pin (the app warns over 300 m).
    (co, p2, am2, private.demo_sg_at(today - 20, 9), 'Entrance mock-up review', 'completed', private.demo_sg_at(today - 20, 9) + interval '25 minutes',
      12.882300, 80.250100, 45, 1850, private.demo_sg_at(today - 20, 10), 'Checked in from the main road — the site was locked', am2, private.demo_sg_at(today - 22), private.demo_sg_at(today - 20, 10)),
    -- Missed: still "scheduled" three days later.
    (co, p2, ex1, private.demo_sg_at(today - 3, 10), 'Check levels before paving', 'scheduled', null, null, null, null, null, null, null, am2, private.demo_sg_at(today - 6), private.demo_sg_at(today - 6)),
    (co, p2, am2, private.demo_sg_at(today - 10, 15), 'Meet the client at site', 'cancelled', null, null, null, null, null, null, 'Client was out of town', am2, private.demo_sg_at(today - 12), private.demo_sg_at(today - 11)),
    -- On site right now.
    (co, p2, ld2, private.demo_sg_at(today, 9), 'Plant selection walk-through', 'checked_in', private.demo_sg_at(today, 9) + interval '5 minutes',
      12.866150, 80.246700, 12, 12, null, null, am2, private.demo_sg_at(today - 1), private.demo_sg_at(today, 9));

  -- ======================================================================
  -- P3  Brigade Tech Park — no lead; in execution; BOQ revisions; site logs; snags. Kiran is designer AND execution.
  -- ======================================================================
  p3 := private.demo_sg_project(co, 'SG-DEMO-03', 'Demo — Brigade Tech Park Courtyard', 'Brigade Facilities Pvt Ltd', '+918040001234', 'facilities.demo@example.com',
    'Brigade Tech Park, Whitefield, Bengaluru', 12.985600, 77.729400, today - 130, today + 30, 'active', 'blue',
    null, adm, today - 131, 18000, 420, 7560000,
    jsonb_build_array(jsonb_build_object('user', am1, 'role', 'architect_manager'), jsonb_build_object('user', ld2, 'role', 'landscape_designer'),
      jsonb_build_object('user', ld2, 'role', 'execution'), jsonb_build_object('user', ex1, 'role', 'execution')));
  perform private.demo_sg_timeline(p3, today - 130, today + 30, 'DDDLDDPNN', ld2, adm, 4);
  update public.project_phases set owner_id = ex1 where project_id = p3 and position in (6, 7);
  update public.project_phases set status = 'skipped', remark = 'Not needed — no changes during execution', submitted_on = null, actual_start = null
  where project_id = p3 and position = 8;
  -- BOQ: R1 and R2 replaced, R3 approved by the client (in execution), R4 draft.
  for r in select * from (values ('R1', 'superseded', 120), ('R2', 'superseded', 100), ('R3', 'client_approved', 75), ('R4', 'draft', 2)) as x(label, status, days) loop
    rev := gen_random_uuid();
    insert into public.project_boq_revisions (id, project_id, label, title, status, notes, sent_at, approved_at, created_by, created_at, updated_at)
    values (rev, p3, r.label, case r.label when 'R3' then 'Hardscape + softscape (approved)' when 'R4' then 'Final with site changes' end, r.status,
      case r.label when 'R4' then 'Two extra planters near the café.' end,
      case when r.status <> 'draft' then now() - (r.days - 2) * interval '1 day' end,
      case when r.status = 'client_approved' then now() - (r.days - 5) * interval '1 day' end,
      ld2, now() - r.days * interval '1 day', now() - (r.days - 5) * interval '1 day');
    insert into public.project_boq_items (revision_id, position, section, item, description, unit, qty, rate, executed_qty) values
      (rev, 1, 'Hardscape', 'Granite paving (flamed)', '600 × 300 × 30 mm', 'sqft', case r.label when 'R1' then 3000 else 3200 end, 185, case r.label when 'R3' then 2400 else 0 end),
      (rev, 2, 'Hardscape', 'Pergola — MS with WPC louvres', null, 'nos', 2, 145000, case r.label when 'R3' then 2 else 0 end),
      (rev, 3, 'Hardscape', 'Seating ledge', null, 'rft', 120, 1800, case r.label when 'R3' then 130 else 0 end), -- executed more than planned
      (rev, 4, 'Softscape', 'Bermuda grass', null, 'sqft', 6000, 28, case r.label when 'R3' then 1500 else 0 end),
      (rev, 5, 'Softscape', 'Areca palms 8 ft', null, 'nos', case r.label when 'R1' then 30 else 24 end, 2200, 0),
      (rev, 6, 'Irrigation', 'Drip irrigation with timer', null, 'lot', 1, 85000, 0),
      (rev, 7, 'Lighting', 'Bollard lights', 'Client supplies the fixtures', 'nos', 18, 0, 0), -- zero rate
      (rev, 8, 'Civil', 'Soil + manure (red soil 3:1)', null, 'cum', 90, 2400, case r.label when 'R3' then 90 else 0 end);
    if r.label = 'R4' then
      insert into public.project_boq_items (revision_id, position, section, item, unit, qty, rate) values (rev, 9, 'Other', 'Extra planters near the café', 'nos', 2, 18500);
    end if;
  end loop;
  insert into public.project_site_logs (project_id, log_date, work_done, workers, issues, created_by, created_at, updated_at)
  select p3, today - d, private.demo_sg_doc(case d % 3 when 0 then 'Paving 220 sq ft done near block B.' when 1 then 'Grass laid on the east lawn.' else 'Pergola columns fixed.' end, 'Work:'),
    case when d = 2 then 0 else 6 + d end, case when d = 2 then 'Rain — no work today.' when d = 4 then 'Granite delivery short by 40 sq ft.' end,
    case when d % 2 = 0 then ex1 else ld2 end, private.demo_sg_at(today - d, 18), private.demo_sg_at(today - d, 18)
  from generate_series(0, 6) d where d <> 5; -- no log on one day
  insert into public.project_snags (project_id, title, details, status, owner_id, due_date, fixed_at, fixed_by, created_by, created_at, updated_at) values
    (p3, 'Paving joint uneven near the lift lobby', null, 'open', ex1, today - 3, null, null, am1, now() - interval '9 days', now() - interval '9 days'), -- overdue
    (p3, 'Two palms drying — replace', 'Under warranty from the nursery', 'open', ex1, today + 4, null, null, am1, now() - interval '2 days', now() - interval '2 days'),
    (p3, 'Bollard 7 not working', null, 'fixed', ld2, today - 6, now() - interval '5 days', ld2, am1, now() - interval '12 days', now() - interval '5 days'),
    (p3, 'Clean cement stains on the seating ledge', null, 'verified', ex1, null, now() - interval '20 days', ex1, am1, now() - interval '25 days', now() - interval '18 days'),
    (p3, 'Nobody owns this yet', null, 'open', null, null, null, null, am1, now() - interval '1 day', now() - interval '1 day');
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, created_by, created_at, updated_at) values
    (gen_random_uuid(), p3, 1, 'Advance', 25, 1890000, 'date', today - 128, adm, private.demo_sg_at(today - 131), private.demo_sg_at(today - 131)),
    (gen_random_uuid(), p3, 2, 'On GFC approval', 25, 1890000, 'date', today - 70, adm, private.demo_sg_at(today - 131), private.demo_sg_at(today - 131)),
    (gen_random_uuid(), p3, 3, 'Material on site', 40, 3024000, 'date', today - 2, adm, private.demo_sg_at(today - 131), private.demo_sg_at(today - 131)), -- due, not overdue yet
    (gen_random_uuid(), p3, 4, 'Handover', 10, 756000, 'date', today + 30, adm, private.demo_sg_at(today - 131), private.demo_sg_at(today - 131));
  insert into public.project_payments (project_id, milestone_id, amount, paid_on, mode, reference, received_by, created_by, created_at, updated_at)
  select p3, id, amount, due_date + 3, case position when 1 then 'bank_transfer' else 'cheque' end, 'Demo ref ' || position, acc, acc,
    private.demo_sg_at(due_date + 3), private.demo_sg_at(due_date + 3)
  from public.project_payment_milestones where project_id = p3 and position in (1, 2);
  insert into public.project_payments (project_id, milestone_id, is_extra, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at)
  values (p3, null, true, 25000, today - 15, 'upi', 'UPI 7788', acc, 'Extra planters (not part of the schedule)', acc, private.demo_sg_at(today - 15), private.demo_sg_at(today - 15));
  perform private.demo_sg_file(p3, 'gfc', 'GFC master plan.pdf', 'pdf', 'pdf', 'application/pdf', ld2, jsonb_build_array(
    jsonb_build_object('status', 'client_approved', 'days', 70, 'size', 5400000, 'by', am1)));
  perform private.demo_sg_file(p3, 'execution_photos', 'Paving progress — block B.png', 'image', 'png', 'image/png', ex1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 1, 'size', 4200000, 'by', am1)));
  perform private.demo_sg_file(p3, 'boq', 'BOQ R3.xlsx', 'office', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ld2, jsonb_build_array(
    jsonb_build_object('status', 'client_approved', 'days', 75, 'size', 64000, 'by', am1)));
  insert into public.site_visits (company_id, project_id, assigned_to, scheduled_at, purpose, status, check_in_at, check_in_lat, check_in_lng,
    check_in_accuracy_m, distance_from_site_m, check_out_at, created_by, created_at, updated_at) values
    (co, p3, ex1, private.demo_sg_at(today, 8), 'Daily site check', 'completed', private.demo_sg_at(today, 8), 12.985650, 77.729350, 6, 7,
      private.demo_sg_at(today, 13), am1, private.demo_sg_at(today - 1), private.demo_sg_at(today, 13)),
    (co, p3, am1, private.demo_sg_at(today + 3, 11), 'Snag walk with the client', 'scheduled', null, null, null, null, null, null, am1, now(), now());

  -- ======================================================================
  -- P4  Sunrise Apartments — completed (late by a few days), fully paid, handed over.
  -- ======================================================================
  p4 := private.demo_sg_project(co, 'SG-DEMO-04', 'Demo — Sunrise Apartments Terrace', 'Sunrise Apartments Owners Association', '+919840011004', 'secretary.demo@example.com',
    'Sunrise Apartments, Velachery Main Road, Chennai', 12.978900, 80.218000, today - 165, today - 15, 'completed', 'amber',
    (lead ->> 'sunrise')::uuid, adm, today - 166, 5400, 480, 2592000,
    jsonb_build_array(jsonb_build_object('user', am2, 'role', 'architect_manager'), jsonb_build_object('user', ld1, 'role', 'landscape_designer'),
      jsonb_build_object('user', ex1, 'role', 'execution')));
  perform private.demo_sg_timeline(p4, today - 165, today - 15, 'DDLDDDLDL', ld1, adm, 6);
  update public.projects set completed_on = today - 9, updated_at = private.demo_sg_at(today - 9) where id = p4;
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (p4, adm, 'status_changed', jsonb_build_object('from', 'active', 'to', 'completed'), private.demo_sg_at(today - 9, 17));
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, created_by, created_at, updated_at)
  select gen_random_uuid(), p4, i, (array['Advance', 'After design approval', 'After BOQ R2', 'At handover'])[i], (array[30, 20, 30, 20])[i],
    (array[777600, 518400, 777600, 518400])[i], 'date', today - (array[163, 120, 90, 12])[i], adm, private.demo_sg_at(today - 166), private.demo_sg_at(today - 166)
  from generate_series(1, 4) i;
  insert into public.project_payments (project_id, milestone_id, amount, paid_on, mode, reference, received_by, created_by, created_at, updated_at)
  select p4, id, amount, due_date + 2, (array['bank_transfer', 'cheque', 'bank_transfer', 'upi'])[position], 'Demo receipt ' || position, acc, acc,
    private.demo_sg_at(due_date + 2), private.demo_sg_at(due_date + 2)
  from public.project_payment_milestones where project_id = p4;
  perform private.demo_sg_file(p4, 'handover', 'Completion report.pdf', 'pdf', 'pdf', 'application/pdf', am2, jsonb_build_array(
    jsonb_build_object('status', 'client_approved', 'days', 9, 'size', 7800000, 'by', am2)));
  insert into public.project_snags (project_id, title, status, owner_id, fixed_at, fixed_by, created_by, created_at, updated_at) values
    (p4, 'Terrace drain outlet blocked', 'verified', ex1, now() - interval '13 days', ex1, am2, now() - interval '16 days', now() - interval '12 days');

  -- ======================================================================
  -- P5  Farmhouse — on hold.   P6  Rooftop café — cancelled.
  -- ======================================================================
  p5 := private.demo_sg_project(co, 'SG-DEMO-05', 'Demo — Farmhouse at Kanakapura', 'Mr. Joseph', '+919840011005', null,
    'Survey no. 112, Kanakapura Road, Bengaluru', null, null, today - 55, today + 70, 'on_hold', 'sky',
    (lead ->> 'farm')::uuid, adm, today - 56, 21780, 210, 4573800,
    jsonb_build_array(jsonb_build_object('user', am1, 'role', 'architect_manager'), jsonb_build_object('user', ld1, 'role', 'landscape_designer')));
  perform private.demo_sg_timeline(p5, today - 55, today + 70, 'DPNNNNNNN', ld1, adm);
  update public.project_phases set remark = 'On hold — client travelling till next month' where project_id = p5 and position = 2;
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (p5, adm, 'status_changed', jsonb_build_object('from', 'active', 'to', 'on_hold'), now() - interval '20 days');
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, created_by, created_at, updated_at)
  values (gen_random_uuid(), p5, 1, 'Advance', 30, 1372140, 'date', today - 50, acc, now() - interval '56 days', now() - interval '56 days'); -- overdue, nothing paid
  -- No site pin yet: the first site visit can set it.
  insert into public.site_visits (company_id, project_id, assigned_to, scheduled_at, purpose, status, created_by, created_at, updated_at)
  values (co, p5, am1, private.demo_sg_at(today + 35, 10), 'First visit after the client is back', 'scheduled', adm, now(), now());

  p6 := private.demo_sg_project(co, 'SG-DEMO-06', 'Demo — Rooftop Café ☕ Bloom', 'Café Bloom', '+919840011006', 'bloom.demo@example.com',
    '4th floor, Khader Nawaz Khan Road, Chennai', 13.060500, 80.252000, today - 45, today + 15, 'cancelled', 'slate',
    (lead ->> 'cafe')::uuid, adm, today - 46, 1200, 900, 1080000,
    jsonb_build_array(jsonb_build_object('user', am2, 'role', 'architect_manager')));
  perform private.demo_sg_timeline(p6, today - 45, today + 15, 'DCNNNNNNN', am2, adm);
  insert into public.project_activities (project_id, actor_id, type, body, created_at) values
    (p6, adm, 'note', 'Client closed the café. Advance refunded outside the CRM.', now() - interval '18 days');
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (p6, adm, 'status_changed', jsonb_build_object('from', 'active', 'to', 'cancelled'), now() - interval '18 days');

  -- ======================================================================
  -- P7  Starts next week — no architect manager yet, no value, no payment schedule.
  -- ======================================================================
  p7 := private.demo_sg_project(co, 'SG-DEMO-07', 'Demo — Dr. Ramaswamy House', 'Dr. K. R. Ramaswamy', '+919840011007', null,
    null, null, null, today + 7, today + 97, 'active', 'violet',
    (lead ->> 'next')::uuid, adm, today - 1, null, null, null, '[]'::jsonb);
  perform private.demo_sg_timeline(p7, today + 7, today + 97, 'NNNNNNNNN', null, adm);

  -- ======================================================================
  -- P8  Tamil + very long name; ends today; phases due today and tomorrow; storage almost full.
  -- ======================================================================
  p8 := private.demo_sg_project(co, 'SG-DEMO-08', 'Demo — ஸ்ரீ லக்ஷ்மி Gardens & Very Long Project Name to Check Wrapping in Tables and Cards',
    'ஸ்ரீ லக்ஷ்மி கார்டன்ஸ்', '+919840011008', null, 'Door 7/2, Gandhi Road, Kanchipuram 631501', 12.834900, 79.703600,
    today - 40, today, 'active', 'pink', (lead ->> 'tamil')::uuid, adm, today - 41, 900, 0, 0,
    jsonb_build_array(jsonb_build_object('user', am2, 'role', 'architect_manager'), jsonb_build_object('user', am2, 'role', 'landscape_designer')));
  -- Meera is architect manager AND designer here (one person, two roles).
  insert into public.project_phases (project_id, position, category, name, color, owner_id, planned_start, deadline, actual_start, submitted_on, status, created_by, created_at, updated_at) values
    (p8, 1, 'Design', 'Layout', 'sky', am2, today - 40, today - 20, today - 40, today - 21, 'done', adm, now() - interval '41 days', now() - interval '21 days'),
    (p8, 2, 'Design', 'Planting list — due today', 'emerald', am2, today - 10, today, today - 10, null, 'in_progress', adm, now() - interval '41 days', now()),
    (p8, 3, 'Execution', 'Planting — due tomorrow (after the project end)', 'orange', am2, today - 3, today + 1, today - 3, null, 'in_progress', adm, now() - interval '41 days', now()),
    (p8, 4, 'Execution', 'Same-day phase', 'amber', null, today, today, null, null, 'not_started', adm, now() - interval '41 days', now());
  update public.projects set storage_quota_bytes = 2147483648 where id = p8; -- 2 GB quota, ~1.9 GB used
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, notes, created_by, created_at, updated_at)
  values (gen_random_uuid(), p8, 1, 'Goodwill — no charge', null, 0, 'date', today - 30, 'Free garden for the temple (₹0)', adm, now() - interval '41 days', now() - interval '41 days');
  perform private.demo_sg_file(p8, 'gfc', 'Master plan (large file).dwg', 'cad', 'dwg', 'image/vnd.dwg', am2, jsonb_build_array(
    jsonb_build_object('status', 'draft', 'days', 5, 'size', 1932735283, 'note', 'Large file — the quota bar should be almost full')));
  perform private.demo_sg_file(p8, 'site_images', 'Walk-through.mp4', 'video', 'mp4', 'video/mp4', am2, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 20, 'size', 96000000, 'by', am2)));
  perform private.demo_sg_file(p8, 'handover', 'All drawings.zip', 'archive', 'zip', 'application/zip', am2, jsonb_build_array(
    jsonb_build_object('status', 'draft', 'days', 1, 'size', 52000000)));

  -- ======================================================================
  -- P9  Archived by mistake.
  -- ======================================================================
  p9 := private.demo_sg_project(co, 'SG-DEMO-09', 'Demo — Archived Test Project', 'Test client', '+919840011009', null, null, null, null,
    today - 30, today + 30, 'active', 'slate', (lead ->> 'archived')::uuid, adm, today - 29, null, null, 100000,
    jsonb_build_array(jsonb_build_object('user', am1, 'role', 'architect_manager')));
  perform private.demo_sg_timeline(p9, today - 30, today + 30, 'PNNNNNNNN', am1, adm);
  update public.projects set archived_at = now() - interval '28 days', archived_by = adm where id = p9;

  -- ======================================================================
  -- P10  Started in November last year — still active and late (the previous year's folder has a late project).
  -- ======================================================================
  p10 := private.demo_sg_project(co, 'SG-DEMO-10', 'Demo — Lakeview Resort Gardens', 'Lakeview Resort Pvt Ltd', '+919840011020', 'gm.lakeview.demo@example.com',
    'Lake Road, Kodaikanal 624101', 10.233500, 77.489200, make_date(ly, 11, 10), today + 20, 'active', 'orange',
    (lead ->> 'lastyear')::uuid, adm, make_date(ly, 11, 9), 30000, 380, 11400000,
    jsonb_build_array(jsonb_build_object('user', am1, 'role', 'architect_manager'), jsonb_build_object('user', ld2, 'role', 'landscape_designer'),
      jsonb_build_object('user', ex1, 'role', 'execution')));
  perform private.demo_sg_timeline(p10, make_date(ly, 11, 10), today + 20, 'DDDDLDPPN', ld2, adm, 5);
  update public.project_phases set owner_id = ex1, remark = 'Monsoon stopped work for six weeks' where project_id = p10 and position = 7;
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, phase_id, created_by, created_at, updated_at) values
    (gen_random_uuid(), p10, 1, 'Advance', 30, 3420000, 'date', make_date(ly, 11, 12), null, acc, private.demo_sg_at(make_date(ly, 11, 9)), private.demo_sg_at(make_date(ly, 11, 9))),
    (gen_random_uuid(), p10, 2, 'Material on site', 50, 5700000, 'date', make_date(ly + 1, 2, 1), null, acc, private.demo_sg_at(make_date(ly, 11, 9)), private.demo_sg_at(make_date(ly, 11, 9))),
    (gen_random_uuid(), p10, 3, 'Handover', 20, 2280000, 'phase', null, (select id from public.project_phases where project_id = p10 and position = 9), acc,
      private.demo_sg_at(make_date(ly, 11, 9)), private.demo_sg_at(make_date(ly, 11, 9)));
  -- Advance in full, then ₹20 lakh of the ₹57 lakh material part: partly paid and overdue for months.
  insert into public.project_payments (project_id, amount, paid_on, mode, reference, received_by, created_by, created_at, updated_at) values
    (p10, 3420000, make_date(ly, 11, 14), 'bank_transfer', 'UTR SBIN0000987654321', acc, acc, private.demo_sg_at(make_date(ly, 11, 14)), private.demo_sg_at(make_date(ly, 11, 14))),
    (p10, 2000000, make_date(ly + 1, 2, 10), 'cheque', 'Cheque 118870 (Canara)', acc, acc, private.demo_sg_at(make_date(ly + 1, 2, 10)), private.demo_sg_at(make_date(ly + 1, 2, 10)));

  -- ======================================================================
  -- P11  Starts 28 Dec last year, ends this year — spans New Year. Completed, two phases skipped.
  -- ======================================================================
  p11 := private.demo_sg_project(co, 'SG-DEMO-11', 'Demo — Mrs. Deepa Nair Courtyard', 'Mrs. Deepa Nair', '+919840011021', null,
    '9, Kamarajar Salai, Adyar, Chennai 600020', 13.006400, 80.257500, make_date(ly, 12, 28), least(make_date(ly + 1, 3, 15), today - 2), 'completed', 'violet',
    (lead ->> 'newyear')::uuid, adm, make_date(ly, 12, 27), 650, 1100, 715000,
    jsonb_build_array(jsonb_build_object('user', am2, 'role', 'architect_manager'), jsonb_build_object('user', ld1, 'role', 'landscape_designer')));
  perform private.demo_sg_timeline(p11, make_date(ly, 12, 28), least(make_date(ly + 1, 3, 15), today - 2), 'DDSDSDDDD', ld1, adm);
  update public.projects set completed_on = least(make_date(ly + 1, 3, 15), today - 1) where id = p11;
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (p11, adm, 'status_changed', jsonb_build_object('from', 'active', 'to', 'completed'), private.demo_sg_at(least(make_date(ly + 1, 3, 15), today - 1), 17));
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, created_by, created_at, updated_at) values
    (gen_random_uuid(), p11, 1, 'Advance', 50, 357500, 'date', make_date(ly, 12, 28), adm, private.demo_sg_at(make_date(ly, 12, 27)), private.demo_sg_at(make_date(ly, 12, 27))),
    (gen_random_uuid(), p11, 2, 'At handover', 50, 357500, 'date', least(make_date(ly + 1, 3, 15), today - 2), adm, private.demo_sg_at(make_date(ly, 12, 27)), private.demo_sg_at(make_date(ly, 12, 27)));
  -- Paid on 31 Dec and 1 Jan: same part, two calendar years.
  insert into public.project_payments (project_id, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at) values
    (p11, 200000, make_date(ly, 12, 31), 'upi', 'UPI 3112', acc, 'New Year''s Eve', acc, private.demo_sg_at(make_date(ly, 12, 31)), private.demo_sg_at(make_date(ly, 12, 31))),
    (p11, 157500, make_date(ly + 1, 1, 1), 'upi', 'UPI 0101', acc, 'New Year''s Day', acc, private.demo_sg_at(make_date(ly + 1, 1, 1)), private.demo_sg_at(make_date(ly + 1, 1, 1))),
    (p11, 357500, least(make_date(ly + 1, 3, 15), today - 2), 'bank_transfer', 'UTR AXIS0000456', acc, null, acc, private.demo_sg_at(least(make_date(ly + 1, 3, 15), today - 2)), private.demo_sg_at(least(make_date(ly + 1, 3, 15), today - 2)));

  -- ======================================================================
  -- P12  Starts next month (a future month folder).  P13  Same month, cancelled before it started.
  -- ======================================================================
  p12 := private.demo_sg_project(co, 'SG-DEMO-12', 'Demo — Olive Tree Montessori Play Garden', 'Olive Tree Montessori', '+919840011022', 'admin.olive.demo@example.com',
    '22, 2nd Avenue, Anna Nagar, Chennai 600040', 13.085000, 80.210100, next_m + 4, next_m + 120, 'active', 'pink',
    (lead ->> 'nextmonth')::uuid, adm, today - 10, 2400, 520, 1248000,
    jsonb_build_array(jsonb_build_object('user', am2, 'role', 'architect_manager'), jsonb_build_object('user', ld1, 'role', 'landscape_designer')));
  perform private.demo_sg_timeline(p12, next_m + 4, next_m + 120, 'NNNNNNNNN', ld1, adm);
  insert into public.project_payment_milestones (id, project_id, position, label, percent, amount, due_trigger, due_date, created_by, created_at, updated_at)
  values (gen_random_uuid(), p12, 1, 'Advance', 40, 499200, 'date', next_m + 4, acc, now() - interval '10 days', now() - interval '10 days'); -- not due yet
  -- Paid before the project even started (money ahead of the first due date).
  insert into public.project_payments (project_id, amount, paid_on, mode, reference, received_by, created_by, created_at, updated_at)
  values (p12, 100000, today - 3, 'cash', 'Cash receipt #41', adm, adm, now() - interval '3 days', now() - interval '3 days');

  p13 := private.demo_sg_project(co, 'SG-DEMO-13', 'Demo — Prakash Farm (cancelled before start)', 'Mr. Prakash', '+919840011023', null,
    'Survey no. 48, Thiruporur, Chengalpattu', null, null, next_m + 10, next_m + 70, 'cancelled', 'slate',
    (lead ->> 'nextcancel')::uuid, adm, today - 14, null, null, 900000,
    jsonb_build_array(jsonb_build_object('user', am1, 'role', 'architect_manager')));
  perform private.demo_sg_timeline(p13, next_m + 10, next_m + 70, 'NNNNNNNNN', am1, adm);
  insert into public.project_activities (project_id, actor_id, type, body, created_at)
  values (p13, adm, 'note', 'Client sold the land. Nothing was paid.', now() - interval '4 days');
  insert into public.project_activities (project_id, actor_id, type, meta, created_at)
  values (p13, adm, 'status_changed', jsonb_build_object('from', 'active', 'to', 'cancelled'), now() - interval '4 days');

  -- ======================================================================
  -- Edge cases on the earlier projects.
  -- ======================================================================
  -- P1: ₹21,000 more than the advance: spills into "After design approval" (partly paid before it is due).
  insert into public.project_payments (project_id, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at)
  values (p1, 21000, today - 5, 'upi', 'UPI/9001 2233', acc, 'Client rounded up the advance', acc, now() - interval '5 days', now() - interval '5 days');
  -- P4: fully paid and then ₹15,000 more towards the schedule: "ahead" of the schedule.
  insert into public.project_payments (project_id, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at)
  values (p4, 15000, today - 8, 'card', 'Card ****4242', acc, 'Paid a little extra by mistake — to adjust later', acc, now() - interval '8 days', now() - interval '8 days');
  -- P3: a post-dated cheque (paid on tomorrow).
  insert into public.project_payments (project_id, amount, paid_on, mode, reference, received_by, notes, created_by, created_at, updated_at)
  values (p3, 500000, today + 1, 'cheque', 'PDC 220019 (HDFC)', acc, 'Post-dated cheque — deposit tomorrow', acc, now(), now());
  -- P2: a designer who has left (switched off) still owns a phase and is still on the team.
  insert into public.project_members (project_id, user_id, member_role, added_by, added_at)
  values (p2, ld3, 'landscape_designer', adm, private.demo_sg_at(today - 81, 12));
  update public.project_phases set owner_id = ld3, remark = 'Owner has left — reassign' where project_id = p2 and position = 5;
  -- P7: no phone, no email, no site.
  update public.projects set client_phone = null, client_email = null where id = p7;

  -- Folders inside folders (P1 and P3). Files go through demo_sg_file with a path.
  perform private.demo_sg_file(p1, 'Site images/Before', 'Before — driveway.png', 'image', 'png', 'image/png', am1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 27, 'size', 2900000, 'by', am1)));
  perform private.demo_sg_file(p1, 'Site images/Before', 'Before — pool deck.png', 'image', 'png', 'image/png', am1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 27, 'size', 3300000, 'by', am1)));
  -- A sub-folder with the same name as its parent.
  perform private.demo_sg_file(p1, 'Site images/Site images', 'Same-name folder test.png', 'image', 'png', 'image/png', am1, jsonb_build_array(
    jsonb_build_object('status', 'draft', 'days', 6, 'size', 120000)));
  -- A custom top-level folder with an empty sub-folder.
  perform private.demo_sg_file(p1, 'Client references', 'Pinterest board.pdf', 'pdf', 'pdf', 'application/pdf', ld1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 24, 'size', 4100000, 'by', am1, 'note', 'Gardens the client likes')));
  perform private.demo_sg_folder(p1, 'Client references/Neighbour''s garden (empty)', ld1);
  -- An archived sub-folder (with an archived file in it).
  perform private.demo_sg_file(p1, 'Layout & deck/Old options', 'Option B layout.pdf', 'pdf', 'pdf', 'application/pdf', ld1, jsonb_build_array(
    jsonb_build_object('status', 'draft', 'days', 20, 'size', 1900000)), null, null, true);
  update public.project_folders set archived_at = now() - interval '10 days'
  where project_id = p1 and name = 'Old options' and parent_id is not null;
  -- Three levels deep, and Before / After.
  perform private.demo_sg_file(p3, 'Execution photos/Week 1/Block A', 'Block A — excavation.png', 'image', 'png', 'image/png', ex1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 40, 'size', 3800000, 'by', am1)));
  perform private.demo_sg_file(p3, 'Execution photos/Week 1/Block B', 'Block B — base layer.png', 'image', 'png', 'image/png', ex1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 39, 'size', 3600000, 'by', am1)));
  perform private.demo_sg_file(p3, 'Execution photos/Week 2', 'Week 2 — granite laid.png', 'image', 'png', 'image/png', ld2, jsonb_build_array(
    jsonb_build_object('status', 'submitted', 'days', 30, 'size', 4000000, 'note', 'Please check the joints')));
  perform private.demo_sg_file(p3, 'Site images/Before', 'Courtyard before.png', 'image', 'png', 'image/png', am1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 125, 'size', 3500000, 'by', am1)));
  perform private.demo_sg_file(p3, 'Site images/After', 'Courtyard after (so far).png', 'image', 'png', 'image/png', ex1, jsonb_build_array(
    jsonb_build_object('status', 'approved', 'days', 1, 'size', 3700000, 'by', am1)));
  perform private.demo_sg_file(p3, 'BOQ/Old revisions', 'BOQ R2.xlsx', 'office', 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ld2, jsonb_build_array(
    jsonb_build_object('status', 'superseded', 'days', 100, 'size', 61000, 'by', am1),
    jsonb_build_object('status', 'approved', 'days', 99, 'size', 62000, 'by', am1, 'note', 'Kept for reference')));

  -- Year / month folder colours on the Projects page (left alone where the company already chose one).
  insert into public.project_folder_colors (company_id, year, month, color, updated_by, updated_at) values
    (co, ly, null, 'amber', adm, now() - interval '2 days'),
    (co, ly + 1, extract(month from today)::int, 'emerald', adm, now() - interval '2 days')
  on conflict do nothing;

  -- ======================================================================
  -- The bell: one item of every project kind, read and unread, an unknown kind, and more than one page for the admin.
  -- ======================================================================
  insert into public.app_notifications (recipient_id, kind, payload, dedupe_key, created_at, read_at)
  select x.who, x.kind, x.payload, 'demo-sg:' || x.kind || ':' || x.n, now() - x.mins * interval '1 minute',
    case when x.is_read then now() - (x.mins - 5) * interval '1 minute' end
  from (values
    (1, adm, 'lead_handed_off', jsonb_build_object('lead_id', lead ->> 'wait2', 'lead_name', 'Demo Prestige Lakeside Clubhouse', 'phone', '+919840011011',
      'note', 'Handed over 11 days ago and still waiting for a project.', 'actor', private.demo_sg_name(bdm2)), 30, false),
    (2, adm, 'project_at_risk', private.demo_sg_pl(p2) || jsonb_build_object('reason', 'phase_after_end', 'last_deadline', today + 25, 'end_date', today + 12), 55, false),
    (3, adm, 'project_at_risk', private.demo_sg_pl(p10) || jsonb_build_object('reason', 'past_end', 'end_date', today - 1, 'late_days', 1), 70, false),
    (4, adm, 'payment_overdue', private.demo_sg_pl(p10) || jsonb_build_object('milestone', 'Material on site', 'balance', 3700000,
      'due_on', make_date(ly + 1, 2, 1), 'days_overdue', today - make_date(ly + 1, 2, 1)), 180, true),
    (5, adm, 'project_completed', private.demo_sg_pl(p4) || jsonb_build_object('completed_on', today - 9, 'actor', private.demo_sg_name(adm)), 60 * 24 * 9, true),
    (6, adm, 'future_kind', jsonb_build_object('something', 'a kind this app version does not know'), 15, false),
    (7, ld1, 'phase_assigned', private.demo_sg_pl(p12) || jsonb_build_object('phase', 'First cut design & estimation — R0', 'deadline', next_m + 10, 'actor', private.demo_sg_name(adm)), 600, false),
    (8, ld1, 'phase_due_soon', private.demo_sg_pl(p1) || jsonb_build_object('phase', 'BOQ — R2', 'deadline', today + 1, 'owner', private.demo_sg_name(ld1)), 120, false),
    (9, ld1, 'phase_overdue', private.demo_sg_pl(p2) || jsonb_build_object('phase', 'GFC drawings', 'deadline', today - 1, 'late_days', 1, 'owner', private.demo_sg_name(ld1)), 240, false),
    (10, ld1, 'phase_overdue', private.demo_sg_pl(p2) || jsonb_build_object('phase', 'Kick-off meeting at site', 'deadline', today - 12, 'late_days', 12, 'owner', null), 250, true),
    (11, ld1, 'phase_changes', private.demo_sg_pl(p2) || jsonb_build_object('phase', 'BOQ — R2', 'actor', private.demo_sg_name(am2),
      'remark', 'Granite instead of pebbles at the entrance, a bigger name board, move the two areca palms away from the gate, swap the bollards for wall lights on the left side, and send a revised quantity for the paving before Friday so we can share it with the client at the site meeting.'), 300, false),
    (12, am1, 'phase_submitted', private.demo_sg_pl(p1) || jsonb_build_object('phase', 'Design development: layout + deck', 'actor', private.demo_sg_name(ld1), 'late_days', 0), 90, false),
    (13, am1, 'phase_submitted', private.demo_sg_pl(p10) || jsonb_build_object('phase', 'GFC drawings', 'actor', private.demo_sg_name(ld2), 'late_days', 5), 60 * 24 * 3, true),
    (14, am1, 'client_feedback', private.demo_sg_pl(p1) || jsonb_build_object('approved', true, 'file', 'Layout plan.pdf', 'version_no', 2, 'client', 'Mr. Hari Prasad'), 60 * 24 * 8, true),
    (15, am1, 'client_feedback', private.demo_sg_pl(p1) || jsonb_build_object('approved', false, 'file', 'Layout plan.pdf', 'version_no', 1,
      'comment', 'Please move the pergola closer to the pool.', 'client', 'Mr. Hari Prasad'), 60 * 24 * 17, true),
    (16, am1, 'boq_status', private.demo_sg_pl(p3) || jsonb_build_object('status', 'client_approved', 'label', 'R3', 'actor', private.demo_sg_name(ld2)), 60 * 24 * 70, true),
    (17, ex1, 'snag_assigned', private.demo_sg_pl(p3) || jsonb_build_object('snag', 'Paving joint uneven near the lift lobby'), 60 * 24 * 9, false),
    (18, ex1, 'site_visit_reminder', jsonb_build_object('project', 'Demo — Brigade Tech Park Courtyard', 'project_id', p3, 'purpose', 'Snag walk with the client',
      'at', private.demo_sg_at(today + 3, 11), 'site_address', 'Brigade Tech Park, Whitefield, Bengaluru', 'phone', '+918040001234'), 45, false),
    (19, am2, 'site_visit_reminder', jsonb_build_object('lead', 'Demo Green Valley School', 'purpose', 'Survey the school grounds',
      'at', private.demo_sg_at(today + 2, 10)), 20, false),
    (20, acc, 'payment_received', private.demo_sg_pl(p1) || jsonb_build_object('amount', 21000, 'mode', 'upi', 'reference', 'UPI/9001 2233',
      'milestone', 'Advance', 'paid_on', today - 5, 'actor', private.demo_sg_name(acc)), 60 * 24 * 5, true),
    (21, acc, 'payment_due', private.demo_sg_pl(p3) || jsonb_build_object('milestone', 'Material on site', 'balance', 3024000, 'due_on', today - 2), 60 * 24 * 2, false),
    (22, acc, 'payment_overdue', private.demo_sg_pl(p5) || jsonb_build_object('milestone', 'Advance', 'balance', 1372140, 'due_on', today - 50, 'days_overdue', 50), 60 * 10, false),
    (23, ld2, 'project_assigned', private.demo_sg_pl(p10) || jsonb_build_object('role', 'landscape_designer', 'actor', private.demo_sg_name(adm)), 60 * 24 * 330, true)
  ) as x(n, who, kind, payload, mins, is_read);
  -- 20 more older ones for the admin, so the bell needs a second page.
  insert into public.app_notifications (recipient_id, kind, payload, dedupe_key, created_at, read_at)
  select adm, 'payment_received', private.demo_sg_pl(p4) || jsonb_build_object('amount', 1000 * i, 'mode', 'cash', 'milestone', 'At handover',
      'paid_on', today - 10 - i, 'actor', private.demo_sg_name(acc)),
    'demo-sg:older:' || i, now() - (10 + i) * interval '1 day', case when i > 3 then now() - (9 + i) * interval '1 day' end
  from generate_series(1, 20) i;

  -- A site visit before any project exists (lead stage), assigned to Raj.
  insert into public.site_visits (company_id, lead_id, assigned_to, scheduled_at, purpose, status, check_in_at, check_in_lat, check_in_lng,
    check_in_accuracy_m, distance_from_site_m, check_out_at, notes, outcome, created_by, created_at, updated_at) values
    (co, (lead ->> 'wait1')::uuid, am1, private.demo_sg_at(today - 7, 11), 'First look at the site', 'completed', private.demo_sg_at(today - 7, 11),
      13.041200, 80.233900, 20, null, private.demo_sg_at(today - 7, 12), private.demo_sg_doc('Wants a vertical garden on the 20 ft compound wall.'),
      'Interested — handed to admin', bdm1, private.demo_sg_at(today - 8), private.demo_sg_at(today - 7, 12)),
    (co, (lead ->> 'pitch1')::uuid, am2, private.demo_sg_at(today + 2, 10), 'Survey the school grounds', 'scheduled', null, null, null, null, null, null, null, null,
      bdm1, now(), now());
end $$;

drop function private.demo_sg_file(uuid, text, text, text, text, text, uuid, jsonb, uuid, uuid, boolean);
drop function private.demo_sg_timeline(uuid, date, date, text, uuid, uuid, integer);
drop function private.demo_sg_project(uuid, text, text, text, text, text, text, numeric, numeric, date, date, public.project_status, text, uuid, uuid, date, numeric, numeric, numeric, jsonb);
drop function private.demo_sg_name(uuid);
drop function private.demo_sg_pl(uuid);
drop function private.demo_sg_folder(uuid, text, uuid);
drop function private.demo_sg_status(uuid, uuid, text, text, text, uuid, timestamptz, date, date);
drop function private.demo_sg_doc(text, text, text);
drop function private.demo_sg_at(date, integer);

commit;

select p.code, p.name, p.status, (select count(*) from public.project_phases ph where ph.project_id = p.id) as phases,
  (select count(*) from public.project_files f where f.project_id = p.id) as files
from public.projects p where p.code like 'SG-DEMO-%' order by p.code;
