-- Pins: at most 50 per person per list (leads, follow-ups), up from 10. Same trigger as
-- 20261006001300_stars_and_pins.sql otherwise; the advisory lock still serializes a person's
-- concurrent pin requests so two of them cannot both pass the count.
create or replace function private.enforce_pin_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer;
begin
  if new.pinned_at is null or (tg_op = 'UPDATE' and old.pinned_at is not null) then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext(tg_table_name || ':' || new.user_id::text));
  if tg_table_name = 'lead_stars' then
    select count(*) into v_count from public.lead_stars s
      where s.user_id = new.user_id and s.pinned_at is not null and s.lead_id <> new.lead_id;
  else
    select count(*) into v_count from public.follow_up_stars s
      where s.user_id = new.user_id and s.pinned_at is not null and s.follow_up_id <> new.follow_up_id;
  end if;
  if v_count >= 50 then
    raise exception 'pin_limit' using errcode = '22023';
  end if;
  return new;
end $$;
