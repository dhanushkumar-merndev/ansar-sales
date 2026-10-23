-- ---------------------------------------------------------------------------
-- Per-person table columns, and how long a call lasted.
--
-- * user_table_prefs: the columns each person hid, per list ({ "leads": [...], "follow_ups": [...] }).
--   Hidden ids are stored, so a column added later shows by default.
-- * set_table_columns: saves the caller's hidden columns for one list.
-- * set_call_duration: the caller's own call, within a day: records (or corrects) its talk time.
-- Additive only: nothing is dropped, deleted or rewritten.
-- ---------------------------------------------------------------------------

create table public.user_table_prefs (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  columns jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_table_prefs enable row level security;

create policy user_table_prefs_select on public.user_table_prefs for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.user_table_prefs to authenticated;

create function public.set_table_columns(p_table text, p_hidden text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_table is null or p_table not in ('leads', 'follow_ups') then
    raise exception 'invalid_table' using errcode = '22023';
  end if;
  if p_hidden is null or cardinality(p_hidden) > 20
     or exists (select 1 from unnest(p_hidden) c where c is null or char_length(c) not between 1 and 40) then
    raise exception 'invalid_columns' using errcode = '22023';
  end if;
  insert into public.user_table_prefs (user_id, columns, updated_at)
  values (v_uid, jsonb_build_object(p_table, to_jsonb(p_hidden)), now())
  on conflict (user_id) do update
    set columns = public.user_table_prefs.columns || jsonb_build_object(p_table, to_jsonb(p_hidden)),
        updated_at = now();
end $$;

create function public.set_call_duration(p_activity_id uuid, p_seconds integer)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_call public.lead_activities%rowtype;
begin
  if p_seconds is null or p_seconds < 0 or p_seconds > 86400 then
    raise exception 'invalid_duration' using errcode = '22023';
  end if;
  select * into v_call from public.lead_activities a where a.id = p_activity_id and a.type = 'call_logged';
  if not found or v_call.actor_id is distinct from (select auth.uid()) or not private.can_access_lead(v_call.lead_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_call.created_at < now() - interval '24 hours' then
    raise exception 'call_outcome_closed' using errcode = '22023';
  end if;
  update public.lead_activities
  set meta = v_call.meta || jsonb_build_object('duration_seconds', p_seconds)
  where id = v_call.id;
end $$;

revoke all on function public.set_table_columns(text, text[]), public.set_call_duration(uuid, integer) from public, anon;
grant execute on function public.set_table_columns(text, text[]), public.set_call_duration(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
