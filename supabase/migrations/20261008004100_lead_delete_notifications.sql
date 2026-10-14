-- ---------------------------------------------------------------------------
-- Bell notifications name their lead only inside the payload, so deleting leads (a client's purge,
-- a fresh start) left notifications pointing at nothing. Deleting leads now removes their bell
-- notifications too: one pass per delete statement, however many leads it removes.
-- ---------------------------------------------------------------------------

create function private.leads_deleted_notifications()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.app_notifications n
  where n.payload ? 'lead_id' and n.payload ->> 'lead_id' in (select o.id::text from gone o);
  return null;
end $$;

create trigger leads_deleted_notifications after delete on public.leads
  referencing old table as gone
  for each statement execute function private.leads_deleted_notifications();

revoke all on function private.leads_deleted_notifications() from public, anon, authenticated;
