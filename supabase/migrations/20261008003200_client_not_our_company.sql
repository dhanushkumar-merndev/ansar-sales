-- ---------------------------------------------------------------------------
-- One of our own companies is never an ads client: a client whose name or company name is the name
-- of one of our companies (Star Growth Hub, Star Gardens, ...) is refused. A won lead of such a
-- company is simply not handed to the ads team. Client CRMs (companies with a parent) don't count:
-- two clients may share a company name.
-- ---------------------------------------------------------------------------

create function private.is_our_company_name(p_name text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.companies c
    where c.parent_company_id is null
      and c.normalized_name = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')))
$$;

create function private.ads_client_not_our_company()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' or new.name is distinct from old.name or new.company_name is distinct from old.company_name)
     and (private.is_our_company_name(new.name) or private.is_our_company_name(new.company_name)) then
    -- The won-lead handoff skips the row instead of failing the lead's status change.
    if tg_op = 'INSERT' and new.lead_id is not null then
      return null;
    end if;
    raise exception 'client_is_our_company' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger ads_clients_not_our_company before insert or update of name, company_name on public.ads_clients
  for each row execute function private.ads_client_not_our_company();

revoke all on function private.is_our_company_name(text), private.ads_client_not_our_company() from public, anon, authenticated;
