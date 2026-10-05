-- Simple CRM: core schema (types, tables, indexes).
-- Business timezone: Asia/Kolkata. All timestamps are stored as UTC timestamptz.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'sales', 'account');

create type public.lead_status as enum (
  'new', 'contacted', 'interested', 'proposal_sent', 'won', 'lost'
);

create type public.follow_up_state as enum ('pending', 'completed', 'cancelled');

create type public.lead_activity_type as enum (
  'lead_created',
  'note',
  'note_corrected',
  'status_changed',
  'assigned',
  'lead_updated',
  'lead_archived',
  'lead_restored',
  'follow_up_scheduled',
  'follow_up_rescheduled',
  'follow_up_updated',
  'follow_up_completed',
  'follow_up_cancelled'
);

create type public.reminder_state as enum (
  'pending', 'processing', 'sent', 'failed', 'skipped', 'cancelled'
);

create type public.telegram_status as enum ('connected', 'blocked');

create type public.expense_category as enum (
  'salary', 'rent', 'software', 'marketing', 'utilities', 'miscellaneous'
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique
    check (username ~ '^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$'),
  display_name text not null
    check (char_length(btrim(display_name)) between 1 and 80),
  role public.app_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_role_active_idx on public.profiles (role, is_active);

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id),
  target_user_id uuid references public.profiles (id),
  action text not null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index admin_audit_log_target_idx on public.admin_audit_log (target_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------
create table public.niches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  normalized_name text generated always as (
    lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))
  ) stored,
  archived_at timestamptz,
  merged_into_id uuid references public.niches (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint niches_normalized_name_key unique (normalized_name),
  constraint niches_not_merged_into_self check (merged_into_id is null or merged_into_id <> id)
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  phone text not null check (char_length(phone) between 4 and 32),
  phone_normalized text not null check (phone_normalized ~ '^\+[1-9][0-9]{6,14}$'),
  email text check (
    email is null or (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
  ),
  niche_id uuid not null references public.niches (id),
  status public.lead_status not null default 'new',
  owner_id uuid not null references public.profiles (id),
  created_by uuid not null references public.profiles (id),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);

create index leads_owner_status_idx on public.leads (owner_id, status) where archived_at is null;
create index leads_created_idx on public.leads (created_at desc, id desc);
create index leads_status_idx on public.leads (status) where archived_at is null;
create index leads_niche_idx on public.leads (niche_id);
create index leads_phone_normalized_idx on public.leads (phone_normalized);
create index leads_email_lower_idx on public.leads (lower(email)) where email is not null;

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id),
  assignee_id uuid not null references public.profiles (id),
  task text not null check (char_length(btrim(task)) between 1 and 500),
  due_at timestamptz not null,
  state public.follow_up_state not null default 'pending',
  outcome text check (outcome is null or char_length(outcome) <= 1000),
  revision integer not null default 1,
  created_by uuid not null references public.profiles (id),
  completed_at timestamptz,
  completed_by uuid references public.profiles (id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index follow_ups_lead_state_due_idx on public.follow_ups (lead_id, state, due_at);
create index follow_ups_pending_due_idx on public.follow_ups (due_at, id) where state = 'pending';
create index follow_ups_assignee_pending_idx on public.follow_ups (assignee_id, due_at) where state = 'pending';
create index follow_ups_completed_idx on public.follow_ups (completed_at desc, id desc) where state = 'completed';

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id),
  actor_id uuid references public.profiles (id),
  type public.lead_activity_type not null,
  body text check (body is null or char_length(body) <= 5000),
  meta jsonb not null default '{}'::jsonb,
  follow_up_id uuid references public.follow_ups (id),
  edited_at timestamptz,
  created_at timestamptz not null default now()
);

create index lead_activities_lead_idx on public.lead_activities (lead_id, created_at desc, id desc);
create index lead_activities_actor_idx on public.lead_activities (actor_id, created_at);

-- ---------------------------------------------------------------------------
-- Telegram + reminders
-- ---------------------------------------------------------------------------
create table public.telegram_connections (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  chat_id bigint not null unique,
  telegram_username text,
  status public.telegram_status not null default 'connected',
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.telegram_link_tokens (
  token_hash text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index telegram_link_tokens_user_idx on public.telegram_link_tokens (user_id);

create table public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  follow_up_id uuid not null references public.follow_ups (id) on delete cascade,
  revision integer not null,
  kind text not null default 'due' check (kind in ('due')),
  recipient_id uuid not null references public.profiles (id),
  due_at timestamptz not null,
  state public.reminder_state not null default 'pending',
  attempts integer not null default 0,
  -- For pending rows: earliest time to (re)try. For processing rows: lease expiry.
  next_attempt_at timestamptz not null,
  lease_token uuid,
  sent_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  telegram_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reminder_deliveries_revision_key unique (follow_up_id, revision, kind)
);

create index reminder_deliveries_due_idx on public.reminder_deliveries (next_attempt_at, id)
  where state in ('pending', 'processing');
create index reminder_deliveries_follow_up_idx on public.reminder_deliveries (follow_up_id, revision desc);
create index reminder_deliveries_final_idx on public.reminder_deliveries (updated_at)
  where state in ('sent', 'failed', 'skipped', 'cancelled');

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------
create table public.capital_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date date not null,
  contributor text not null check (char_length(btrim(contributor)) between 1 and 120),
  amount numeric(14, 2) not null check (amount > 0),
  description text check (description is null or char_length(description) <= 500),
  created_by uuid not null references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);

create index capital_entries_date_idx on public.capital_entries (entry_date desc, id desc);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  category public.expense_category not null,
  amount numeric(14, 2) not null check (amount > 0),
  description text check (description is null or char_length(description) <= 500),
  created_by uuid not null references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles (id)
);

create index expenses_date_idx on public.expenses (expense_date desc, id desc);
create index expenses_category_date_idx on public.expenses (category, expense_date) where archived_at is null;

create table public.finance_activities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('capital', 'expense')),
  entity_id uuid not null,
  action text not null check (action in ('created', 'updated', 'archived', 'restored')),
  actor_id uuid references public.profiles (id),
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index finance_activities_entity_idx on public.finance_activities (entity_type, entity_id, created_at desc);
create index finance_activities_created_idx on public.finance_activities (created_at desc, id desc);
