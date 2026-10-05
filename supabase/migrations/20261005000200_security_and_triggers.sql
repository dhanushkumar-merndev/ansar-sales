-- Simple CRM: authorization helpers, audit triggers, Row Level Security and grants.

-- ---------------------------------------------------------------------------
-- Helper functions (private schema is not exposed through the Data API)
-- ---------------------------------------------------------------------------

-- Role of the signed-in user, or null when signed out / deactivated / no profile.
-- Re-read on every request, so deactivation and role changes apply immediately.
create function private.app_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.is_active
$$;

create function private.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.app_role() = 'admin', false) $$;

create function private.is_lead_user()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.app_role() in ('admin', 'sales'), false) $$;

create function private.is_finance_user()
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce(private.app_role() in ('admin', 'account'), false) $$;

-- Admin: any lead. Sales: leads it currently owns that are not archived.
create function private.can_access_lead(p_lead_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.leads l
    where l.id = p_lead_id
      and (
        private.app_role() = 'admin'
        or (private.app_role() = 'sales' and l.owner_id = (select auth.uid()) and l.archived_at is null)
      )
  )
$$;

create function private.display_name(p_user_id uuid)
returns text
language sql stable security definer set search_path = ''
as $$ select p.display_name from public.profiles p where p.id = p_user_id $$;

create function private.clean_label(p_value text)
returns text
language sql immutable
as $$ select nullif(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g'), '') $$;

create function private.escape_like(p_value text)
returns text
language sql immutable
as $$ select replace(replace(replace(p_value, '\', '\\'), '%', '\%'), '_', '\_') $$;

create function private.raise_forbidden()
returns void
language plpgsql
as $$ begin raise exception 'forbidden' using errcode = '42501'; end $$;

-- Generic updated_at maintenance.
create function private.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();
create trigger niches_touch before update on public.niches
  for each row execute function private.touch_updated_at();
create trigger telegram_connections_touch before update on public.telegram_connections
  for each row execute function private.touch_updated_at();
create trigger reminder_deliveries_touch before update on public.reminder_deliveries
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Profiles are created from Auth users that an Admin (or the bootstrap script)
-- creates with trusted app_metadata. Creating the Auth user and the profile is
-- therefore one database transaction: if the profile is rejected (for example
-- a duplicate username) the Auth user is not created either.
-- ---------------------------------------------------------------------------
create function private.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.raw_app_meta_data ? 'crm_role' then
    insert into public.profiles (id, username, display_name, role)
    values (
      new.id,
      new.raw_app_meta_data ->> 'crm_username',
      btrim(new.raw_app_meta_data ->> 'crm_display_name'),
      (new.raw_app_meta_data ->> 'crm_role')::public.app_role
    );
    insert into public.admin_audit_log (actor_id, target_user_id, action, meta)
    values (
      (select p.id from public.profiles p
        where p.id = nullif(new.raw_app_meta_data ->> 'crm_created_by', '')::uuid),
      new.id,
      'user_created',
      jsonb_build_object('role', new.raw_app_meta_data ->> 'crm_role')
    );
  end if;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Niches
-- ---------------------------------------------------------------------------
create function private.niches_before_write()
returns trigger
language plpgsql
as $$
begin
  new.name := private.clean_label(new.name);
  if tg_op = 'INSERT' then
    new.created_by := coalesce((select auth.uid()), new.created_by);
  end if;
  return new;
end $$;

create trigger niches_before_write before insert or update on public.niches
  for each row execute function private.niches_before_write();

-- Resolve an existing niche id or create (idempotently) a niche from a typed
-- label. Runs as the caller so RLS insert policies apply.
create function private.resolve_niche(p_niche_id uuid, p_new_niche text)
returns uuid
language plpgsql security invoker set search_path = ''
as $$
declare
  v_id uuid;
  v_archived timestamptz;
  v_merged uuid;
  v_label text := private.clean_label(p_new_niche);
begin
  if p_niche_id is null then
    if v_label is null then
      raise exception 'niche_required' using errcode = '22023';
    end if;
    if char_length(v_label) > 60 then
      raise exception 'niche_too_long' using errcode = '22023';
    end if;
    insert into public.niches (name) values (v_label)
      on conflict (normalized_name) do nothing
      returning id into v_id;
    if v_id is not null then
      return v_id;
    end if;
    select n.id into p_niche_id from public.niches n
      where n.normalized_name = lower(v_label);
  end if;

  select n.id, n.archived_at, n.merged_into_id into v_id, v_archived, v_merged
    from public.niches n where n.id = p_niche_id;
  if v_id is null then
    raise exception 'niche_not_found' using errcode = 'P0002';
  end if;
  if v_merged is not null then
    return v_merged;
  end if;
  if v_archived is not null then
    raise exception 'niche_archived' using errcode = '22023';
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create function private.assert_valid_owner(p_owner_id uuid)
returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = p_owner_id and p.is_active and p.role in ('sales', 'admin')
  ) then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;
end $$;

create function private.leads_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.name := btrim(new.name);
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');

  if tg_op = 'INSERT' then
    new.created_by := coalesce(v_uid, new.created_by);
    new.owner_id := coalesce(new.owner_id, new.created_by);
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    new.archived_at := null;
    new.archived_by := null;
    perform private.assert_valid_owner(new.owner_id);
    return new;
  end if;

  -- UPDATE
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.version := old.version + 1;
  new.updated_at := now();

  if new.owner_id is distinct from old.owner_id then
    if v_uid is not null and not private.is_admin() then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    perform private.assert_valid_owner(new.owner_id);
  end if;

  if new.archived_at is distinct from old.archived_at then
    if v_uid is not null and not private.is_admin() then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if new.archived_at is not null then
      new.archived_at := now();
      new.archived_by := v_uid;
    else
      new.archived_by := null;
    end if;
  end if;
  return new;
end $$;

create trigger leads_before_write before insert or update on public.leads
  for each row execute function private.leads_before_write();

create function private.leads_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, new.created_by, 'lead_created', jsonb_build_object(
      'status', new.status,
      'owner', private.display_name(new.owner_id),
      'niche', (select n.name from public.niches n where n.id = new.niche_id)
    ));
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'status_changed',
      jsonb_build_object('from', old.status, 'to', new.status));
  end if;

  if new.owner_id is distinct from old.owner_id then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'assigned', jsonb_build_object(
      'from', private.display_name(old.owner_id),
      'to', private.display_name(new.owner_id)
    ));
    -- Keep pending follow-ups (and therefore reminder recipients) with the current owner.
    update public.follow_ups f set assignee_id = new.owner_id
      where f.lead_id = new.id and f.state = 'pending' and f.assignee_id <> new.owner_id;
  end if;

  if new.name is distinct from old.name then
    v_changes := v_changes || jsonb_build_object('Name', jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  if new.phone is distinct from old.phone then
    v_changes := v_changes || jsonb_build_object('Phone', jsonb_build_object('from', old.phone, 'to', new.phone));
  end if;
  if new.email is distinct from old.email then
    v_changes := v_changes || jsonb_build_object('Email', jsonb_build_object('from', old.email, 'to', new.email));
  end if;
  if new.niche_id is distinct from old.niche_id then
    v_changes := v_changes || jsonb_build_object('Niche', jsonb_build_object(
      'from', (select n.name from public.niches n where n.id = old.niche_id),
      'to', (select n.name from public.niches n where n.id = new.niche_id)));
  end if;
  if v_changes <> '{}'::jsonb then
    insert into public.lead_activities (lead_id, actor_id, type, meta)
    values (new.id, v_uid, 'lead_updated', jsonb_build_object('changes', v_changes));
  end if;

  if new.archived_at is distinct from old.archived_at then
    insert into public.lead_activities (lead_id, actor_id, type)
    values (new.id, v_uid, case when new.archived_at is null then 'lead_restored' else 'lead_archived' end::public.lead_activity_type);
  end if;
  return null;
end $$;

create trigger leads_after_write after insert or update on public.leads
  for each row execute function private.leads_after_write();

-- ---------------------------------------------------------------------------
-- Lead activities (notes are inserted by users; other events by triggers)
-- ---------------------------------------------------------------------------
create function private.lead_activities_before_insert()
returns trigger
language plpgsql
as $$
begin
  if new.type = 'note' then
    new.actor_id := coalesce((select auth.uid()), new.actor_id);
    new.body := btrim(coalesce(new.body, ''));
    new.meta := '{}'::jsonb;
    new.edited_at := null;
    new.created_at := now();
    if new.body = '' then
      raise exception 'note_required' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

create trigger lead_activities_before_insert before insert on public.lead_activities
  for each row execute function private.lead_activities_before_insert();

-- ---------------------------------------------------------------------------
-- Follow-ups and reminder deliveries
-- ---------------------------------------------------------------------------
create function private.follow_ups_before_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_owner uuid;
  v_archived timestamptz;
begin
  new.task := btrim(new.task);
  new.outcome := nullif(btrim(coalesce(new.outcome, '')), '');

  if tg_op = 'INSERT' then
    select l.owner_id, l.archived_at into v_owner, v_archived
      from public.leads l where l.id = new.lead_id;
    if v_owner is null then
      raise exception 'lead_not_found' using errcode = 'P0002';
    end if;
    if v_archived is not null then
      raise exception 'lead_archived' using errcode = '22023';
    end if;
    new.assignee_id := v_owner;
    new.created_by := coalesce(v_uid, new.created_by);
    new.state := 'pending';
    new.revision := 1;
    new.outcome := null;
    new.completed_at := null;
    new.completed_by := null;
    new.cancelled_at := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  new.id := old.id;
  new.lead_id := old.lead_id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();

  if old.state <> 'pending' then
    raise exception 'follow_up_closed' using errcode = '22023';
  end if;

  if new.state = 'completed' then
    new.completed_at := now();
    new.completed_by := v_uid;
  elsif new.state = 'cancelled' then
    new.cancelled_at := now();
  elsif new.due_at is distinct from old.due_at or new.assignee_id is distinct from old.assignee_id then
    new.revision := old.revision + 1;
  else
    new.revision := old.revision;
  end if;
  return new;
end $$;

create trigger follow_ups_before_write before insert or update on public.follow_ups
  for each row execute function private.follow_ups_before_write();

create function private.follow_ups_after_write()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, meta)
    values (new.lead_id, new.created_by, 'follow_up_scheduled', new.id,
      jsonb_build_object('task', new.task, 'due_at', new.due_at));
    insert into public.reminder_deliveries (follow_up_id, revision, recipient_id, due_at, next_attempt_at)
    values (new.id, new.revision, new.assignee_id, new.due_at, new.due_at)
    on conflict (follow_up_id, revision, kind) do nothing;
    return null;
  end if;

  if new.state <> 'pending' then
    -- Completed or cancelled: no further reminders for this follow-up.
    update public.reminder_deliveries d
      set state = 'cancelled', last_error = 'follow_up_' || new.state::text, lease_token = null
      where d.follow_up_id = new.id and d.state = 'pending';
    insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, body, meta)
    values (new.lead_id, v_uid,
      case when new.state = 'completed' then 'follow_up_completed' else 'follow_up_cancelled' end::public.lead_activity_type,
      new.id, new.outcome, jsonb_build_object('task', new.task, 'due_at', new.due_at));
    return null;
  end if;

  if new.revision <> old.revision then
    -- Supersede the previous revision and schedule the new one in the same transaction.
    update public.reminder_deliveries d
      set state = 'cancelled', last_error = 'superseded', lease_token = null
      where d.follow_up_id = new.id and d.revision < new.revision and d.state = 'pending';
    insert into public.reminder_deliveries (follow_up_id, revision, recipient_id, due_at, next_attempt_at)
    values (new.id, new.revision, new.assignee_id, new.due_at, new.due_at)
    on conflict (follow_up_id, revision, kind) do nothing;
  end if;

  if new.due_at is distinct from old.due_at then
    insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, meta)
    values (new.lead_id, v_uid, 'follow_up_rescheduled', new.id, jsonb_build_object(
      'task', new.task, 'from', old.due_at, 'to', new.due_at,
      'previous_task', case when new.task is distinct from old.task then old.task end));
  elsif new.task is distinct from old.task then
    insert into public.lead_activities (lead_id, actor_id, type, follow_up_id, meta)
    values (new.lead_id, v_uid, 'follow_up_updated', new.id, jsonb_build_object(
      'task', new.task, 'previous_task', old.task, 'due_at', new.due_at));
  end if;
  return null;
end $$;

create trigger follow_ups_after_write after insert or update on public.follow_ups
  for each row execute function private.follow_ups_after_write();

-- ---------------------------------------------------------------------------
-- Finance audit trail
-- ---------------------------------------------------------------------------
create function private.finance_before_write()
returns trigger
language plpgsql
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  new.description := nullif(btrim(coalesce(new.description, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := coalesce(v_uid, new.created_by);
    new.created_at := now();
    new.updated_at := now();
    new.updated_by := null;
    new.archived_at := null;
    new.archived_by := null;
    return new;
  end if;
  new.id := old.id;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  new.updated_at := now();
  new.updated_by := v_uid;
  if new.archived_at is distinct from old.archived_at then
    if new.archived_at is not null then
      new.archived_at := now();
      new.archived_by := v_uid;
    else
      new.archived_by := null;
    end if;
  end if;
  return new;
end $$;

create function private.finance_after_write()
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
  foreach v_key in array array['entry_date', 'expense_date', 'contributor', 'category', 'amount', 'description'] loop
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

create trigger capital_entries_before_write before insert or update on public.capital_entries
  for each row execute function private.finance_before_write();
create trigger capital_entries_after_write after insert or update on public.capital_entries
  for each row execute function private.finance_after_write();
create trigger expenses_before_write before insert or update on public.expenses
  for each row execute function private.finance_before_write();
create trigger expenses_after_write after insert or update on public.expenses
  for each row execute function private.finance_after_write();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.niches enable row level security;
alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;
alter table public.follow_ups enable row level security;
alter table public.telegram_connections enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.reminder_deliveries enable row level security;
alter table public.capital_entries enable row level security;
alter table public.expenses enable row level security;
alter table public.finance_activities enable row level security;

-- Profiles: active staff can see the staff directory (no Auth emails are stored
-- here); a deactivated user can still read their own row to see their status.
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.app_role()) is not null);

create policy admin_audit_log_select on public.admin_audit_log for select to authenticated
  using ((select private.is_admin()));

create policy niches_select on public.niches for select to authenticated
  using ((select private.is_lead_user()));
create policy niches_insert on public.niches for insert to authenticated
  with check ((select private.is_lead_user()) and archived_at is null and merged_into_id is null);
create policy niches_update on public.niches for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy leads_select on public.leads for select to authenticated
  using (
    (select private.app_role()) = 'admin'
    or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and archived_at is null)
  );
create policy leads_insert on public.leads for insert to authenticated
  with check (
    (select private.app_role()) = 'admin'
    or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and created_by = (select auth.uid()))
  );
create policy leads_update on public.leads for update to authenticated
  using (
    (select private.app_role()) = 'admin'
    or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and archived_at is null)
  )
  with check (
    (select private.app_role()) = 'admin'
    or ((select private.app_role()) = 'sales' and owner_id = (select auth.uid()) and archived_at is null)
  );

create policy lead_activities_select on public.lead_activities for select to authenticated
  using (private.can_access_lead(lead_id));
create policy lead_activities_insert_note on public.lead_activities for insert to authenticated
  with check (type = 'note' and actor_id = (select auth.uid()) and private.can_access_lead(lead_id));

create policy follow_ups_select on public.follow_ups for select to authenticated
  using (private.can_access_lead(lead_id));
create policy follow_ups_insert on public.follow_ups for insert to authenticated
  with check (private.can_access_lead(lead_id) and created_by = (select auth.uid()));
create policy follow_ups_update on public.follow_ups for update to authenticated
  using (private.can_access_lead(lead_id)) with check (private.can_access_lead(lead_id));

create policy reminder_deliveries_select on public.reminder_deliveries for select to authenticated
  using (exists (
    select 1 from public.follow_ups f
    where f.id = follow_up_id and private.can_access_lead(f.lead_id)
  ));

create policy telegram_connections_select_own on public.telegram_connections for select to authenticated
  using (user_id = (select auth.uid()) and (select private.app_role()) is not null);
-- telegram_link_tokens: no policies (only security definer functions touch it).

create policy capital_entries_select on public.capital_entries for select to authenticated
  using ((select private.is_finance_user()));
create policy capital_entries_insert on public.capital_entries for insert to authenticated
  with check ((select private.is_finance_user()) and created_by = (select auth.uid()));
create policy capital_entries_update on public.capital_entries for update to authenticated
  using ((select private.is_finance_user())) with check ((select private.is_finance_user()));

create policy expenses_select on public.expenses for select to authenticated
  using ((select private.is_finance_user()));
create policy expenses_insert on public.expenses for insert to authenticated
  with check ((select private.is_finance_user()) and created_by = (select auth.uid()));
create policy expenses_update on public.expenses for update to authenticated
  using ((select private.is_finance_user())) with check ((select private.is_finance_user()));

create policy finance_activities_select on public.finance_activities for select to authenticated
  using ((select private.is_finance_user()));

-- ---------------------------------------------------------------------------
-- Table privileges (defence in depth on top of RLS). anon gets nothing.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;

grant select on public.profiles to authenticated;
grant select on public.admin_audit_log to authenticated;
grant select on public.niches to authenticated;
grant insert (name) on public.niches to authenticated;
grant update (name, archived_at) on public.niches to authenticated;

grant select on public.leads to authenticated;
grant insert (name, phone, phone_normalized, email, niche_id, status, owner_id, created_by)
  on public.leads to authenticated;
grant update (name, phone, phone_normalized, email, niche_id, status, owner_id, archived_at)
  on public.leads to authenticated;

grant select on public.lead_activities to authenticated;
grant insert (lead_id, type, body, actor_id) on public.lead_activities to authenticated;

grant select on public.follow_ups to authenticated;
grant insert (lead_id, task, due_at, created_by) on public.follow_ups to authenticated;
grant update (task, due_at, state, outcome) on public.follow_ups to authenticated;

grant select (id, follow_up_id, revision, recipient_id, due_at, state, attempts, sent_at, last_error, created_at, updated_at)
  on public.reminder_deliveries to authenticated;

grant select (user_id, telegram_username, status, last_error, connected_at, updated_at)
  on public.telegram_connections to authenticated;

grant select on public.capital_entries to authenticated;
grant insert (entry_date, contributor, amount, description, created_by) on public.capital_entries to authenticated;
grant update (entry_date, contributor, amount, description, archived_at) on public.capital_entries to authenticated;

grant select on public.expenses to authenticated;
grant insert (expense_date, category, amount, description, created_by) on public.expenses to authenticated;
grant update (expense_date, category, amount, description, archived_at) on public.expenses to authenticated;

grant select on public.finance_activities to authenticated;

grant usage on schema private to authenticated, service_role;
revoke all on all functions in schema private from public, anon;
grant execute on function
  private.app_role(),
  private.is_admin(),
  private.is_lead_user(),
  private.is_finance_user(),
  private.can_access_lead(uuid),
  private.clean_label(text),
  private.escape_like(text),
  private.resolve_niche(uuid, text)
to authenticated, service_role;
