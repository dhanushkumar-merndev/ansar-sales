-- ---------------------------------------------------------------------------
-- update_lead raised version_conflict with SQLSTATE 40001 (serialization_failure).
-- PostgREST treats 40001 as a transient transaction failure and re-runs the
-- transaction, so a deterministic edit conflict spun until the API gateway timed
-- out (~2 minutes, HTTP 504) instead of telling the user. PT409 is not retried
-- and PostgREST returns it as HTTP 409 Conflict.
-- ---------------------------------------------------------------------------
create or replace function public.update_lead(
  p_id uuid,
  p_version integer,
  p_name text,
  p_phone text,
  p_phone_normalized text,
  p_email text default null,
  p_niche_id uuid default null,
  p_new_niche text default null,
  p_allow_duplicate boolean default false
)
returns integer
language plpgsql security invoker set search_path = ''
as $$
declare
  v_niche uuid;
  v_version integer;
  v_current_phone text;
begin
  if not private.is_lead_user() then
    perform private.raise_forbidden();
  end if;
  select l.phone_normalized into v_current_phone from public.leads l where l.id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_current_phone <> p_phone_normalized and not coalesce(p_allow_duplicate, false)
     and (public.check_duplicate_phone(p_phone_normalized, p_id) ->> 'duplicate')::boolean then
    raise exception 'duplicate_phone' using errcode = '23505';
  end if;

  v_niche := private.resolve_niche(p_niche_id, p_new_niche);

  update public.leads l
    set name = p_name, phone = p_phone, phone_normalized = p_phone_normalized,
        email = p_email, niche_id = v_niche
    where l.id = p_id and l.version = p_version
    returning l.version into v_version;
  if v_version is null then
    raise exception 'version_conflict' using errcode = 'PT409';
  end if;
  return v_version;
end $$;

