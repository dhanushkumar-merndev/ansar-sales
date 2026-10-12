-- ---------------------------------------------------------------------------
-- Client payments of any amount, applied to the schedule automatically.
--
-- * A payment goes "towards the schedule" (the default) or is an extra (work outside the
--   schedule, e.g. two more planters). Schedule payments fill the parts in order: the oldest
--   open part first, any excess spills into the next part. So ₹1,00,000 against a ₹2,34,000
--   advance leaves the advance partly paid with ₹1,34,000 still due (and overdue alerts keep
--   running) until more money comes in. Money beyond the whole schedule shows as "ahead".
-- * project_payments.milestone_id is kept for old rows only; it no longer decides anything.
-- * Money is for Admin (incl. super admin) and Accounts only: architect managers no longer
--   get even the paid / due status of the parts. The client still sees their own schedule in
--   the portal.
-- ---------------------------------------------------------------------------

alter table public.project_payments add column is_extra boolean not null default false;
-- Rows recorded "outside the schedule" before this migration.
update public.project_payments set is_extra = true where milestone_id is null;
grant insert (is_extra), update (is_extra) on public.project_payments to authenticated;

-- Paid towards one part = what the schedule payments cover after all earlier parts are full.
create or replace function private.milestone_json(m public.project_payment_milestones, p_money boolean)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with x as (
    select
      (select coalesce(sum(p.amount), 0) from public.project_payments p
        where p.project_id = m.project_id and p.archived_at is null and not p.is_extra) as pool,
      (select coalesce(sum(o.amount), 0) from public.project_payment_milestones o
        where o.project_id = m.project_id and o.archived_at is null and (o.position, o.id) < (m.position, m.id)) as before,
      private.milestone_due_on(m) as due_on,
      private.ist_today() as today
  ), y as (
    select x.*, least(greatest(x.pool - x.before, 0), m.amount) as paid from x
  )
  select jsonb_strip_nulls(jsonb_build_object(
    'id', m.id, 'position', m.position, 'label', m.label, 'due_trigger', m.due_trigger, 'due_date', m.due_date,
    'phase', (select jsonb_build_object('id', ph.id, 'name', ph.name, 'status', ph.status) from public.project_phases ph where ph.id = m.phase_id),
    'due_on', y.due_on, 'version', m.version,
    'status', case
      when y.paid >= m.amount and (m.amount > 0 or y.due_on is not null and y.due_on <= y.today) then 'paid'
      when y.due_on is not null and y.due_on < y.today - 7 then 'overdue'
      when y.paid > 0 then 'partly_paid'
      when y.due_on is not null and y.due_on <= y.today then 'due'
      else 'upcoming' end,
    'days_overdue', case when y.paid < m.amount and y.due_on is not null and y.due_on < y.today then y.today - y.due_on end,
    'percent', case when p_money then m.percent end,
    'amount', case when p_money then m.amount end,
    'paid', case when p_money then y.paid end,
    'balance', case when p_money then m.amount - y.paid end,
    'notes', case when p_money then m.notes end))
  from y
$$;

-- Money roles only (the team never sees payments).
create or replace function public.project_payment_status(p_project_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_value numeric;
  v_scheduled numeric;
  v_towards numeric;
begin
  if not private.can_access_project(p_project_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not private.can_see_project_money(p_project_id) then
    perform private.raise_forbidden();
  end if;
  select f.contract_value into v_value from public.project_financials f where f.project_id = p_project_id;
  select coalesce(sum(m.amount), 0) into v_scheduled from public.project_payment_milestones m
  where m.project_id = p_project_id and m.archived_at is null;
  select coalesce(sum(p.amount), 0) into v_towards from public.project_payments p
  where p.project_id = p_project_id and p.archived_at is null and not p.is_extra;
  return jsonb_build_object(
    'money', true,
    'contract_value', v_value,
    'scheduled', v_scheduled,
    'received', (select coalesce(sum(p.amount), 0) from public.project_payments p where p.project_id = p_project_id and p.archived_at is null),
    'extra', (select coalesce(sum(p.amount), 0) from public.project_payments p where p.project_id = p_project_id and p.archived_at is null and p.is_extra),
    'schedule_open', greatest(v_scheduled - v_towards, 0),
    'ahead', greatest(v_towards - v_scheduled, 0),
    'milestones', coalesce((select jsonb_agg(private.milestone_json(m, true) order by m.position, m.id)
      from public.project_payment_milestones m where m.project_id = p_project_id and m.archived_at is null), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'amount', p.amount, 'paid_on', p.paid_on, 'mode', p.mode, 'reference', p.reference, 'notes', p.notes,
        'is_extra', p.is_extra, 'milestone_id', p.milestone_id,
        'milestone', (select m.label from public.project_payment_milestones m where m.id = p.milestone_id),
        'received_by', private.display_name(p.received_by), 'version', p.version, 'created_at', p.created_at)
        order by p.paid_on desc, p.created_at desc)
      from public.project_payments p where p.project_id = p_project_id and p.archived_at is null), '[]'::jsonb)
  );
end $$;

-- History: say where the money went.
create or replace function private.project_payments_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_label text := case when new.is_extra then 'Extra (outside the schedule)'
    else coalesce((select m.label from public.project_payment_milestones m where m.id = new.milestone_id), 'Payment schedule') end;
begin
  if tg_op = 'INSERT' then
    perform private.log_project(new.project_id, 'payment_recorded', jsonb_build_object('money', true, 'amount', new.amount,
      'mode', new.mode, 'paid_on', new.paid_on, 'milestone', v_label, 'reference', new.reference));
  elsif new.archived_at is distinct from old.archived_at then
    perform private.log_project(new.project_id, 'payment_removed', jsonb_build_object('money', true, 'amount', new.amount,
      'paid_on', new.paid_on, 'milestone', v_label, 'restored', new.archived_at is null));
  elsif (new.amount, new.paid_on, new.mode, new.is_extra, new.reference) is distinct from (old.amount, old.paid_on, old.mode, old.is_extra, old.reference) then
    perform private.log_project(new.project_id, 'payment_updated', jsonb_build_object('money', true,
      'from', jsonb_build_object('amount', old.amount, 'paid_on', old.paid_on, 'mode', old.mode),
      'to', jsonb_build_object('amount', new.amount, 'paid_on', new.paid_on, 'mode', new.mode), 'milestone', v_label));
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Portal fix, repeated here because 20261008001000/001100 may already be applied without it: a version the
-- team sent back ("changes requested" before approval, no client comment) is never shown to the client.
-- ---------------------------------------------------------------------------
create or replace function private.client_version(p_file_id uuid)
returns public.project_file_versions
language sql stable security definer set search_path = ''
as $$
  select v.* from public.project_file_versions v
  where v.file_id = p_file_id
    and (v.status in ('approved', 'client_approved') or (v.status = 'changes_requested' and v.client_comment is not null))
  order by v.version_no desc limit 1
$$;

create or replace function public.list_project_folder(p_project_id uuid, p_folder_id uuid default null, p_search text default null, p_limit integer default 50, p_offset integer default 0)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;
  with f as (
    select fi.* from public.project_files fi
    where fi.project_id = p_project_id and fi.archived_at is null
      and (case when v_pattern is not null then true else fi.folder_id is not distinct from p_folder_id end)
      and (v_pattern is null or fi.name ilike v_pattern)
  ), page as (
    select f.*, row_number() over (order by f.updated_at desc, f.id) as rn from f order by rn limit p_limit offset p_offset
  )
  select (select count(*) from f),
    coalesce((select jsonb_agg(jsonb_build_object(
      'id', pg.id, 'name', pg.name, 'kind', pg.kind, 'folder_id', pg.folder_id, 'updated_at', pg.updated_at, 'created_at', pg.created_at,
      'phase', (select jsonb_build_object('id', ph.id, 'name', ph.name) from public.project_phases ph where ph.id = pg.phase_id),
      'current', (select jsonb_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'size_bytes', v.size_bytes,
          'mime_type', v.mime_type, 'storage_path', v.storage_path, 'created_at', v.created_at,
          'uploaded_by', (select pr.display_name from public.profiles pr where pr.id = v.uploaded_by))
        from public.project_file_versions v where v.id = pg.current_version_id),
      'client_version', (select jsonb_build_object('version_no', v.version_no, 'status', v.status) from public.project_file_versions v
        where v.file_id = pg.id and (v.status in ('approved', 'client_approved') or (v.status = 'changes_requested' and v.client_comment is not null))
        order by v.version_no desc limit 1),
      'versions', (select count(*) from public.project_file_versions v where v.file_id = pg.id),
      'open_comments', (select count(*) from public.project_file_comments c join public.project_file_versions v on v.id = c.version_id
        where v.file_id = pg.id and c.resolved_at is null),
      'client_seen_at', (select max(e.created_at) from public.project_file_events e where e.file_id = pg.id and e.from_client)
    ) order by pg.rn) from page pg), '[]'::jsonb)
  into v_total, v_items;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;
