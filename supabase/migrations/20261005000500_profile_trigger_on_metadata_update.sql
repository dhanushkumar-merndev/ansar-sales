-- ---------------------------------------------------------------------------
-- Supabase Auth's admin createUser inserts the auth.users row first and writes
-- the supplied app_metadata with a follow-up UPDATE in the same transaction,
-- so an insert-only trigger never sees crm_role. Create the profile on the
-- first write that carries it. Later metadata changes never touch an existing
-- profile: the role stays authoritative in public.profiles.
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.raw_app_meta_data ? 'crm_role'
     and not exists (select 1 from public.profiles p where p.id = new.id) then
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

drop trigger on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of raw_app_meta_data on auth.users
  for each row execute function private.handle_new_auth_user();
