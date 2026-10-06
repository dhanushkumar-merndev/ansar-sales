-- Merged finance and dynamic expense categories.
--
-- * finance_groups: one set of books. Every company starts in its own group; the super admin can
--   merge companies into one group. Finance users (admin/account) of every company in a group see
--   all of its entries; each entry keeps the company it belongs to, so splitting a company out
--   again is lossless.
-- * companies.finance_can_edit: in a merged group, only the companies the super admin picks may
--   add or change entries; the others are view-only. A company alone in its group can always edit.
-- * expense_categories: per group, creatable while saving an expense (like niches). Merging joins
--   categories by name. expenses.category stays as the category's name (kept in sync by a
--   trigger), so grouping by category in reports and history keeps working.

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------
create table public.finance_groups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

alter table public.companies
  add column finance_group_id uuid references public.finance_groups (id),
  add column finance_can_edit boolean not null default true;

do $$
declare
  c record;
  g uuid;
begin
  for c in select x.id from public.companies x loop
    insert into public.finance_groups default values returning id into g;
    update public.companies set finance_group_id = g where id = c.id;
  end loop;
end $$;

alter table public.companies alter column finance_group_id set not null;
create index companies_finance_group_idx on public.companies (finance_group_id);

-- A new company starts with its own books and the default categories.
create function private.companies_new_finance_group()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.finance_group_id is null then
    insert into public.finance_groups default values returning id into new.finance_group_id;
    insert into public.expense_categories (finance_group_id, name)
    select new.finance_group_id, n.name
    from (values ('Salary'), ('Rent'), ('Software'), ('Marketing'), ('Utilities'), ('Miscellaneous')) as n(name);
  end if;
  return new;
end $$;


-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.finance_group_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select c.finance_group_id from public.companies c where c.id = private.current_company_id()
$$;

-- Companies whose books the signed-in user sees: every active company in the current company's group.
create function private.finance_company_ids()
returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(c.id), '{}') from public.companies c
  where c.finance_group_id = private.finance_group_id() and c.archived_at is null
$$;

-- May add or change finance entries: a finance user whose company may edit its (possibly merged) books.
create function private.can_edit_finance()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.is_finance_user() and (
    private.is_super_admin()
    or exists (
      select 1 from public.companies c
      where c.id = private.current_company_id()
        and (c.finance_can_edit or (select count(*) from public.companies x
                                    where x.finance_group_id = c.finance_group_id and x.archived_at is null) = 1)
    )
  )
$$;

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  finance_group_id uuid not null references public.finance_groups (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  normalized_name text generated always as (lower(regexp_replace(btrim(name), '\s+', ' ', 'g'))) stored,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint expense_categories_group_name_key unique (finance_group_id, normalized_name)
);

insert into public.expense_categories (finance_group_id, name)
select g.id, n.name
from public.finance_groups g
cross join (values ('Salary'), ('Rent'), ('Software'), ('Marketing'), ('Utilities'), ('Miscellaneous')) as n(name);

create trigger companies_new_finance_group before insert on public.companies
  for each row execute function private.companies_new_finance_group();

alter table public.expenses add column category_id uuid references public.expense_categories (id);
alter table public.expense_recurrences add column category_id uuid references public.expense_categories (id);

-- Backfill without firing the write triggers (no history rows, no notifications).
alter table public.expenses disable trigger user;
alter table public.expense_recurrences disable trigger user;
update public.expenses e set category_id = ec.id
from public.companies c, public.expense_categories ec
where c.id = e.company_id and ec.finance_group_id = c.finance_group_id and ec.normalized_name = e.category::text;
update public.expense_recurrences r set category_id = ec.id
from public.companies c, public.expense_categories ec
where c.id = r.company_id and ec.finance_group_id = c.finance_group_id and ec.normalized_name = r.category::text;

-- category becomes the category's display name.
alter table public.expenses alter column category type text using initcap(category::text);
alter table public.expense_recurrences alter column category type text using initcap(category::text);
alter table public.expenses enable trigger user;
alter table public.expense_recurrences enable trigger user;

-- The sync trigger always sets the name; the default only keeps it optional on insert.
alter table public.expenses alter column category set default '';
alter table public.expense_recurrences alter column category set default '';
alter table public.expenses alter column category_id set not null;
alter table public.expense_recurrences alter column category_id set not null;
create index expenses_category_id_idx on public.expenses (category_id);

-- Functions typed on the old fixed list: finance_period_totals is no longer used; list_finance_entries is recreated below.
drop function public.finance_period_totals(text, boolean, public.expense_category, integer);
drop function public.list_finance_entries(text, date, date, text, public.expense_category, text, boolean, boolean, text, text, integer, integer);
drop index public.expenses_category_date_idx;
drop type public.expense_category;
create index expenses_category_date_idx on public.expenses (category_id, expense_date) where archived_at is null;

-- Keeps category (the name) in sync with category_id, and checks the category belongs to the
-- books of the entry's company. A write that gives only a category name (or changes just the name)
-- is matched to that books' category of the same name. Runs after zz_company_guard.
create function private.expense_category_sync()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_cat public.expense_categories%rowtype;
begin
  if new.category_id is null
     or (tg_op = 'UPDATE' and new.category_id = old.category_id and new.category is distinct from old.category) then
    select ec.id into new.category_id from public.expense_categories ec
    where ec.finance_group_id = (select c.finance_group_id from public.companies c where c.id = new.company_id)
      and ec.normalized_name = lower(regexp_replace(btrim(coalesce(new.category, '')), '\s+', ' ', 'g'));
  end if;
  select * into v_cat from public.expense_categories ec where ec.id = new.category_id;
  if not found or v_cat.finance_group_id <> (select c.finance_group_id from public.companies c where c.id = new.company_id) then
    raise exception 'category_not_found' using errcode = 'P0002';
  end if;
  if (tg_op = 'INSERT' or new.category_id is distinct from old.category_id) and v_cat.archived_at is not null then
    raise exception 'category_archived' using errcode = '22023';
  end if;
  new.category := v_cat.name;
  return new;
end $$;

create trigger zz_category_sync before insert or update on public.expenses
  for each row execute function private.expense_category_sync();
create trigger zz_category_sync before insert or update on public.expense_recurrences
  for each row execute function private.expense_category_sync();

-- Returns an existing category id, or creates one from a typed name (idempotent per group).
create function public.resolve_expense_category(p_id uuid default null, p_new_name text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_group uuid := private.finance_group_id();
  v_label text := private.clean_label(p_new_name);
  v_id uuid;
begin
  if not private.can_edit_finance() then
    perform private.raise_forbidden();
  end if;
  if p_id is not null then
    select ec.id into v_id from public.expense_categories ec
    where ec.id = p_id and ec.finance_group_id = v_group and ec.archived_at is null;
    if v_id is null then
      raise exception 'category_not_found' using errcode = 'P0002';
    end if;
    return v_id;
  end if;
  if v_label is null then
    raise exception 'category_required' using errcode = '22023';
  end if;
  if char_length(v_label) > 40 then
    raise exception 'category_too_long' using errcode = '22023';
  end if;
  insert into public.expense_categories (finance_group_id, name, created_by)
  values (v_group, v_label, (select auth.uid()))
  on conflict (finance_group_id, normalized_name) do nothing
  returning id into v_id;
  if v_id is null then
    select ec.id into v_id from public.expense_categories ec
    where ec.finance_group_id = v_group and ec.normalized_name = lower(regexp_replace(v_label, '\s+', ' ', 'g'));
    -- Typing an archived category's name brings it back.
    update public.expense_categories set archived_at = null where id = v_id and archived_at is not null;
  end if;
  return v_id;
end $$;

-- Renames or archives/restores a category; entries keep their category (names follow a rename).
create function public.update_expense_category(p_id uuid, p_name text default null, p_archived boolean default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := private.clean_label(p_name);
begin
  if not private.can_edit_finance() then
    perform private.raise_forbidden();
  end if;
  if not exists (select 1 from public.expense_categories ec where ec.id = p_id and ec.finance_group_id = private.finance_group_id()) then
    raise exception 'category_not_found' using errcode = 'P0002';
  end if;
  update public.expense_categories set
    name = coalesce(v_name, name),
    archived_at = case when p_archived is null then archived_at when p_archived then coalesce(archived_at, now()) else null end
  where id = p_id;
  if v_name is not null then
    update public.expenses set category = v_name where category_id = p_id and category is distinct from v_name;
    update public.expense_recurrences set category = v_name where category_id = p_id and category is distinct from v_name;
  end if;
exception when unique_violation then
  raise exception 'category_name_taken' using errcode = '23505';
end $$;

-- ---------------------------------------------------------------------------
-- Merge and split (super admin)
-- ---------------------------------------------------------------------------
-- Moves one company's books into a group: its categories join the group's by name.
create function private.move_company_books(p_company_id uuid, p_group_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old uuid := (select c.finance_group_id from public.companies c where c.id = p_company_id);
  v_alone boolean;
begin
  if v_old = p_group_id then
    return;
  end if;
  v_alone := not exists (select 1 from public.companies c where c.finance_group_id = v_old and c.id <> p_company_id);
  -- The new group gets every category the company uses (and, if it leaves an empty group, all of them).
  insert into public.expense_categories (finance_group_id, name, created_by, archived_at)
  select p_group_id, ec.name, ec.created_by, ec.archived_at
  from public.expense_categories ec
  where ec.finance_group_id = v_old and (v_alone
    or exists (select 1 from public.expenses e where e.category_id = ec.id and e.company_id = p_company_id)
    or exists (select 1 from public.expense_recurrences r where r.category_id = ec.id and r.company_id = p_company_id))
  on conflict (finance_group_id, normalized_name) do nothing;

  update public.companies set finance_group_id = p_group_id where id = p_company_id;

  update public.expenses e set category_id = n.id
  from public.expense_categories o, public.expense_categories n
  where e.company_id = p_company_id and o.id = e.category_id and o.finance_group_id = v_old
    and n.finance_group_id = p_group_id and n.normalized_name = o.normalized_name;
  update public.expense_recurrences r set category_id = n.id
  from public.expense_categories o, public.expense_categories n
  where r.company_id = p_company_id and o.id = r.category_id and o.finance_group_id = v_old
    and n.finance_group_id = p_group_id and n.normalized_name = o.normalized_name;

  if v_alone then
    delete from public.expense_categories where finance_group_id = v_old;
    delete from public.finance_groups where id = v_old;
  end if;
end $$;

-- Merges the companies' books into one. p_editor_ids: which of them may add or change entries.
create function public.merge_finance(p_company_ids uuid[], p_editor_ids uuid[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_group uuid;
  v_id uuid;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if coalesce(cardinality(p_company_ids), 0) < 2
     or (select count(*) from public.companies c where c.id = any(p_company_ids) and c.archived_at is null) <> cardinality(p_company_ids)
     or not coalesce(p_editor_ids <@ p_company_ids, false) or coalesce(cardinality(p_editor_ids), 0) < 1 then
    raise exception 'invalid_books_merge' using errcode = '22023';
  end if;
  -- Join the first company's books (keeps a merged group's other members).
  select c.finance_group_id into v_group from public.companies c where c.id = p_company_ids[1];
  foreach v_id in array p_company_ids loop
    perform private.move_company_books(v_id, v_group);
  end loop;
  update public.companies set finance_can_edit = (id = any(p_editor_ids)) where finance_group_id = v_group;
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'finance_merged', jsonb_build_object('company_ids', p_company_ids, 'editor_ids', p_editor_ids));
  return v_group;
end $$;

-- Gives a company its own books again (its entries go with it; categories are copied).
create function public.split_finance(p_company_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_old uuid := (select c.finance_group_id from public.companies c where c.id = p_company_id);
  v_new uuid;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  if v_old is null or not exists (select 1 from public.companies c where c.finance_group_id = v_old and c.id <> p_company_id) then
    raise exception 'not_merged' using errcode = '22023';
  end if;
  insert into public.finance_groups default values returning id into v_new;
  -- The company keeps the whole category list it had (active ones), plus any it used.
  insert into public.expense_categories (finance_group_id, name, created_by)
  select v_new, ec.name, ec.created_by from public.expense_categories ec
  where ec.finance_group_id = v_old and ec.archived_at is null;
  perform private.move_company_books(p_company_id, v_new);
  update public.companies set finance_can_edit = true where id = p_company_id;
  -- Books left with one company, or with no editor company, become editable by all of them.
  update public.companies c set finance_can_edit = true
  where c.finance_group_id = v_old
    and ((select count(*) from public.companies x where x.finance_group_id = v_old) = 1
      or not exists (select 1 from public.companies x where x.finance_group_id = v_old and x.finance_can_edit));
  insert into public.admin_audit_log (actor_id, action, meta)
  values ((select auth.uid()), 'finance_split', jsonb_build_object('company_id', p_company_id));
end $$;

create function public.set_finance_editors(p_company_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_group uuid;
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  select c.finance_group_id into v_group from public.companies c where c.id = p_company_ids[1];
  if v_group is null or exists (
    select 1 from unnest(p_company_ids) x where not exists (
      select 1 from public.companies c where c.id = x and c.finance_group_id = v_group)) then
    raise exception 'invalid_books_merge' using errcode = '22023';
  end if;
  update public.companies set finance_can_edit = (id = any(p_company_ids)) where finance_group_id = v_group;
end $$;

-- Finance groups with their companies, for Super settings.
create function public.super_finance_groups()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_super_admin() then
    perform private.raise_forbidden();
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'companies', (
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'can_edit', c.finance_can_edit) order by c.created_at, c.id)
      from public.companies c where c.finance_group_id = g.id and c.archived_at is null)) order by g.created_at, g.id), '[]'::jsonb)
    from public.finance_groups g
    where exists (select 1 from public.companies c where c.finance_group_id = g.id and c.archived_at is null)
  );
end $$;

-- The signed-in user's books: which companies they cover and whether this user may edit them.
create function public.finance_context()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when private.is_finance_user() then jsonb_build_object(
    'can_edit', private.can_edit_finance(),
    'current_company_id', private.current_company_id(),
    'companies', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'can_edit', c.finance_can_edit) order by c.created_at, c.id), '[]'::jsonb)
      from public.companies c where c.id = any(private.finance_company_ids()))
  ) end
$$;

-- Expense and capital totals per company in a range (for merged books).
create function public.finance_company_split(p_from date, p_to date)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
    'expense', coalesce((select sum(e.amount) from public.expenses e where e.company_id = c.id and e.archived_at is null and e.expense_date between p_from and p_to), 0),
    'capital', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id = c.id and k.archived_at is null and k.entry_date between p_from and p_to), 0)
  ) order by c.created_at, c.id), '[]'::jsonb)
  from public.companies c
  where private.is_finance_user() and c.id = any(private.finance_company_ids())
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: finance rows are visible across the group, writable by editors
-- ---------------------------------------------------------------------------
drop policy capital_entries_select on public.capital_entries;
drop policy capital_entries_insert on public.capital_entries;
drop policy capital_entries_update on public.capital_entries;
create policy capital_entries_select on public.capital_entries for select to authenticated
  using ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]));
create policy capital_entries_insert on public.capital_entries for insert to authenticated
  with check ((select private.can_edit_finance()) and company_id = any((select private.finance_company_ids())::uuid[])
    and created_by = (select auth.uid()));
create policy capital_entries_update on public.capital_entries for update to authenticated
  using ((select private.can_edit_finance()) and company_id = any((select private.finance_company_ids())::uuid[]))
  with check ((select private.can_edit_finance()) and company_id = any((select private.finance_company_ids())::uuid[]));

drop policy expenses_select on public.expenses;
drop policy expenses_insert on public.expenses;
drop policy expenses_update on public.expenses;
create policy expenses_select on public.expenses for select to authenticated
  using ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]));
create policy expenses_insert on public.expenses for insert to authenticated
  with check ((select private.can_edit_finance()) and company_id = any((select private.finance_company_ids())::uuid[])
    and created_by = (select auth.uid()));
create policy expenses_update on public.expenses for update to authenticated
  using ((select private.can_edit_finance()) and company_id = any((select private.finance_company_ids())::uuid[]))
  with check ((select private.can_edit_finance()) and company_id = any((select private.finance_company_ids())::uuid[]));

drop policy expense_recurrences_select on public.expense_recurrences;
create policy expense_recurrences_select on public.expense_recurrences for select to authenticated
  using ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]));

drop policy finance_activities_select on public.finance_activities;
create policy finance_activities_select on public.finance_activities for select to authenticated
  using ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]));

alter table public.finance_groups enable row level security;
alter table public.expense_categories enable row level security;
create policy expense_categories_select on public.expense_categories for select to authenticated
  using ((select private.is_finance_user()) and finance_group_id = (select private.finance_group_id()));

-- Finance users see who wrote entries in their books (names only), including other merged companies.
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or ((select private.app_role()) is not null
        and (company_id = (select private.current_company_id()) or role = 'super_admin'))
    or ((select private.is_finance_user()) and company_id = any((select private.finance_company_ids())::uuid[]))
  );

-- ---------------------------------------------------------------------------
-- Guard: finance rows belong to any company of the user's books
-- ---------------------------------------------------------------------------
create or replace function private.company_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row record;
begin
  if tg_op = 'DELETE' then
    v_row := old;
  elsif tg_op = 'UPDATE' then
    -- Finance entries may move to another company of the same books; everything else keeps its company.
    if tg_table_name not in ('capital_entries', 'expenses') then
      new.company_id := old.company_id;
    elsif v_uid is not null and not private.is_super_admin()
          and not (old.company_id = any(private.finance_company_ids())) then
      perform private.raise_forbidden();
    end if;
    v_row := new;
  else
    if tg_table_name = 'library_files' then
      new.company_id := (select f.company_id from public.library_folders f where f.id = new.folder_id);
    elsif tg_table_name = 'finance_activities' then
      new.company_id := case new.entity_type
        when 'capital' then (select c.company_id from public.capital_entries c where c.id = new.entity_id)
        else (select e.company_id from public.expenses e where e.id = new.entity_id) end;
    elsif tg_table_name = 'expenses' then
      if new.recurrence_id is not null and new.company_id is null then
        new.company_id := (select r.company_id from public.expense_recurrences r where r.id = new.recurrence_id);
      end if;
    end if;
    if v_uid is not null then
      new.company_id := coalesce(new.company_id, private.current_company_id());
    end if;
    v_row := new;
  end if;

  if v_uid is not null and not private.is_super_admin() and not (
    case when tg_table_name in ('capital_entries', 'expenses', 'expense_recurrences', 'finance_activities')
      then coalesce(v_row.company_id = any(private.finance_company_ids()), false)
      else v_row.company_id is not distinct from private.current_company_id() end
  ) then
    perform private.raise_forbidden();
  end if;

  if tg_op <> 'DELETE' and tg_table_name = 'leads' then
    if (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id) and not exists (
      select 1 from public.profiles p
      where p.id = new.owner_id and (p.company_id = new.company_id or p.role = 'super_admin')
    ) then
      raise exception 'invalid_owner' using errcode = '22023';
    end if;
    if (tg_op = 'INSERT' or new.niche_id is distinct from old.niche_id) and not exists (
      select 1 from public.niches n where n.id = new.niche_id and n.company_id = new.company_id
    ) then
      raise exception 'niche_not_found' using errcode = 'P0002';
    end if;
  elsif tg_op = 'INSERT' and tg_table_name = 'library_folders' then
    if new.parent_id is not null and not exists (
      select 1 from public.library_folders f where f.id = new.parent_id and f.company_id = new.company_id
    ) then
      raise exception 'folder_not_found' using errcode = 'P0002';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Entry list: category by id, optional company filter, and each entry's company
-- ---------------------------------------------------------------------------
create function public.list_finance_entries(
  p_kind text,
  p_from date,
  p_to date,
  p_search text default null,
  p_category_id uuid default null,
  p_mode text default null,
  p_recurring boolean default false,
  p_archived boolean default false,
  p_sort text default 'date',
  p_dir text default 'desc',
  p_limit integer default 20,
  p_offset integer default 0,
  p_company_id uuid default null
)
returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_term text := private.clean_label(p_search);
  v_pattern text;
  v_total bigint;
  v_items jsonb;
begin
  if not private.is_finance_user() then
    perform private.raise_forbidden();
  end if;
  if p_kind not in ('expense', 'capital') or p_from is null or p_to is null or p_from > p_to
     or p_sort not in ('date', 'amount') or p_dir not in ('asc', 'desc')
     or (p_mode is not null and p_mode not in ('cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other', 'unspecified'))
     or (p_kind = 'capital' and (p_category_id is not null or coalesce(p_recurring, false))) then
    raise exception 'invalid_period_query' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if v_term is not null then
    if char_length(v_term) > 100 then
      raise exception 'search_too_long' using errcode = '22023';
    end if;
    v_pattern := '%' || private.escape_like(v_term) || '%';
  end if;

  if p_kind = 'expense' then
    with filtered as (
      select e.* from public.expenses e
      where e.expense_date between p_from and p_to
        and (case when coalesce(p_archived, false) then e.archived_at is not null else e.archived_at is null end)
        and (p_category_id is null or e.category_id = p_category_id)
        and (p_company_id is null or e.company_id = p_company_id)
        and (p_mode is null or coalesce(e.payment_mode, 'unspecified') = p_mode)
        and (not coalesce(p_recurring, false) or e.recurrence_id is not null)
        and (v_pattern is null or e.item ilike v_pattern or e.description ilike v_pattern)
    ), page as (
      select f.*, row_number() over (order by
        case when p_sort = 'date' and p_dir = 'desc' then f.expense_date end desc,
        case when p_sort = 'date' and p_dir = 'asc' then f.expense_date end asc,
        case when p_sort = 'amount' and p_dir = 'desc' then f.amount end desc,
        case when p_sort = 'amount' and p_dir = 'asc' then f.amount end asc,
        case when p_dir = 'desc' then f.id end desc, case when p_dir = 'asc' then f.id end asc) as rn
      from filtered f order by rn limit p_limit offset p_offset
    )
    select (select count(*) from filtered),
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pg.id, 'expense_date', pg.expense_date, 'category', pg.category, 'category_id', pg.category_id,
        'company', (select jsonb_build_object('id', c.id, 'name', c.name) from public.companies c where c.id = pg.company_id), 'amount', pg.amount, 'payment_mode', pg.payment_mode,
        'item', pg.item, 'quantity', pg.quantity, 'description', pg.description, 'archived_at', pg.archived_at, 'updated_at', pg.updated_at,
        'recurrence', (select jsonb_build_object('active', r.active, 'next_date', r.next_date) from public.expense_recurrences r where r.id = pg.recurrence_id),
        'author', (select jsonb_build_object('display_name', p.display_name) from public.profiles p where p.id = pg.created_by)
      ) order by pg.rn), '[]'::jsonb) from page pg)
    into v_total, v_items;
  else
    with filtered as (
      select c.* from public.capital_entries c
      where c.entry_date between p_from and p_to
        and (case when coalesce(p_archived, false) then c.archived_at is not null else c.archived_at is null end)
        and (p_mode is null or coalesce(c.payment_mode, 'unspecified') = p_mode)
        and (p_company_id is null or c.company_id = p_company_id)
        and (v_pattern is null or c.item ilike v_pattern or c.description ilike v_pattern or c.contributor ilike v_pattern)
    ), page as (
      select f.*, row_number() over (order by
        case when p_sort = 'date' and p_dir = 'desc' then f.entry_date end desc,
        case when p_sort = 'date' and p_dir = 'asc' then f.entry_date end asc,
        case when p_sort = 'amount' and p_dir = 'desc' then f.amount end desc,
        case when p_sort = 'amount' and p_dir = 'asc' then f.amount end asc,
        case when p_dir = 'desc' then f.id end desc, case when p_dir = 'asc' then f.id end asc) as rn
      from filtered f order by rn limit p_limit offset p_offset
    )
    select (select count(*) from filtered),
      (select coalesce(jsonb_agg(jsonb_build_object(
        'id', pg.id, 'entry_date', pg.entry_date, 'contributor', pg.contributor,
        'company', (select jsonb_build_object('id', c.id, 'name', c.name) from public.companies c where c.id = pg.company_id), 'amount', pg.amount, 'payment_mode', pg.payment_mode,
        'item', pg.item, 'quantity', pg.quantity, 'description', pg.description, 'archived_at', pg.archived_at, 'updated_at', pg.updated_at,
        'author', (select jsonb_build_object('display_name', p.display_name) from public.profiles p where p.id = pg.created_by)
      ) order by pg.rn), '[]'::jsonb) from page pg)
    into v_total, v_items;
  end if;
  return jsonb_build_object('items', v_items, 'total', v_total);
end $$;

revoke all on function public.list_finance_entries(text, date, date, text, uuid, text, boolean, boolean, text, text, integer, integer, uuid) from public, anon;
grant execute on function public.list_finance_entries(text, date, date, text, uuid, text, boolean, boolean, text, text, integer, integer, uuid) to authenticated;

-- History names the company (and records moves between companies of the same books).
create or replace function private.finance_after_write()
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
      v_new - array['id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'archived_at', 'archived_by', 'company_id', 'category_id', 'recurrence_id']
        || jsonb_build_object('company', (select c.name from public.companies c where c.id = new.company_id)));
    return null;
  end if;

  v_old := to_jsonb(old);
  if new.company_id is distinct from old.company_id then
    v_changes := jsonb_build_object('company', jsonb_build_object(
      'from', (select c.name from public.companies c where c.id = old.company_id),
      'to', (select c.name from public.companies c where c.id = new.company_id)));
  end if;
  foreach v_key in array array['entry_date', 'expense_date', 'contributor', 'category', 'amount', 'payment_mode', 'item', 'quantity', 'description'] loop
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

-- Repeating series copy the expense's company and category.
create or replace function public.set_expense_recurrence(p_expense_id uuid, p_repeat boolean)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  e public.expenses%rowtype;
  v_last date;
  v_id uuid;
begin
  if not private.can_edit_finance() then
    perform private.raise_forbidden();
  end if;
  select * into e from public.expenses x where x.id = p_expense_id and x.archived_at is null for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  if not coalesce(p_repeat, false) then
    update public.expense_recurrences set active = false, updated_at = now() where id = e.recurrence_id;
    return e.recurrence_id;
  end if;

  if e.recurrence_id is null then
    insert into public.expense_recurrences (company_id, category_id, amount, payment_mode, item, quantity, description, day_of_month, next_date, created_by)
    values (e.company_id, e.category_id, e.amount, e.payment_mode, e.item, e.quantity, e.description, extract(day from e.expense_date)::smallint,
      private.next_month_on_day(e.expense_date, extract(day from e.expense_date)::integer), v_uid)
    returning id into v_id;
    update public.expenses set recurrence_id = v_id where id = e.id;
    return v_id;
  end if;

  -- Existing series: this expense becomes the template; the next date follows the series' latest expense.
  select max(x.expense_date) into v_last from public.expenses x where x.recurrence_id = e.recurrence_id;
  update public.expense_recurrences set
    category_id = e.category_id, amount = e.amount, payment_mode = e.payment_mode, item = e.item, quantity = e.quantity,
    description = e.description, day_of_month = extract(day from e.expense_date)::smallint,
    next_date = private.next_month_on_day(v_last, extract(day from e.expense_date)::integer),
    active = true, updated_at = now()
  where id = e.recurrence_id;
  return e.recurrence_id;
end $$;

create or replace function private.generate_recurring_expenses()
returns integer
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_today date := private.ist_today();
  r public.expense_recurrences%rowtype;
  v_date date;
  v_expense uuid;
  v_added integer := 0;
  v_runs integer;
begin
  for r in
    select * from public.expense_recurrences x where x.active and x.next_date <= v_today
    order by x.next_date, x.id for update skip locked
  loop
    v_date := r.next_date;
    v_runs := 0;
    while v_date <= v_today and v_runs < 12 loop
      v_expense := null;
      insert into public.expenses (expense_date, category_id, amount, payment_mode, item, quantity, description, created_by, recurrence_id, company_id)
      values (v_date, r.category_id, r.amount, r.payment_mode, r.item, r.quantity, r.description, r.created_by, r.id, r.company_id)
      on conflict (recurrence_id, expense_date) where recurrence_id is not null do nothing
      returning id into v_expense;

      if v_expense is not null then
        v_added := v_added + 1;
        perform private.enqueue_for_books(r.company_id, 'recurring_expense',
          jsonb_build_object('expense_id', v_expense, 'date', v_date, 'category', r.category, 'amount', r.amount,
            'item', r.item, 'quantity', r.quantity, 'payment_mode', r.payment_mode, 'description', r.description),
          'recurring_expense:' || v_expense);
      end if;

      v_date := private.next_month_on_day(v_date, r.day_of_month);
      v_runs := v_runs + 1;
    end loop;
    update public.expense_recurrences set next_date = v_date, updated_at = now() where id = r.id;
  end loop;
  return v_added;
end $$;

-- Finance notices go to the admins and accounts of every company sharing the books, naming the entry's company.
create function private.enqueue_for_books(
  p_company_id uuid, p_kind text, p_payload jsonb, p_dedupe text, p_actor uuid default null
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_count integer := 0;
  v_payload jsonb := p_payload;
  c record;
begin
  -- Merged books: everyone sees which company the entry is for.
  if (select count(*) from public.companies x
      where x.finance_group_id = (select y.finance_group_id from public.companies y where y.id = p_company_id)
        and x.archived_at is null) > 1 then
    v_payload := v_payload || jsonb_build_object('company', (select y.name from public.companies y where y.id = p_company_id));
  end if;
  -- The entry's own company first, so the super admin's copy names it.
  for c in
    select x.id from public.companies x
    where x.finance_group_id = (select y.finance_group_id from public.companies y where y.id = p_company_id) and x.archived_at is null
    order by x.id <> p_company_id, x.created_at
  loop
    v_count := v_count + private.enqueue_for_company(c.id, array['admin', 'account']::public.app_role[], p_kind, v_payload, p_dedupe, p_actor);
  end loop;
  return v_count;
end $$;

create or replace function private.notify_finance_entry()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'expenses' then
    -- Recurring expenses already send their own 'recurring_expense' notice.
    if new.recurrence_id is not null then
      return null;
    end if;
    perform private.enqueue_for_books(new.company_id, 'expense_added',
      jsonb_build_object('id', new.id, 'date', new.expense_date, 'category', new.category, 'amount', new.amount,
        'item', new.item, 'quantity', new.quantity, 'payment_mode', new.payment_mode, 'description', new.description,
        'actor', private.display_name(new.created_by)),
      'expense_added:' || new.id, new.created_by);
  else
    perform private.enqueue_for_books(new.company_id, 'capital_added',
      jsonb_build_object('id', new.id, 'date', new.entry_date, 'contributor', new.contributor, 'amount', new.amount,
        'item', new.item, 'quantity', new.quantity, 'payment_mode', new.payment_mode, 'description', new.description,
        'actor', private.display_name(new.created_by)),
      'capital_added:' || new.id, new.created_by);
  end if;
  return null;
end $$;

create or replace function private.enqueue_digests(p_now timestamptz default now())
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_day date := v_local::date;
  v_hour integer := extract(hour from v_local);
  v_day_start timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_day_end timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_month_start date := date_trunc('month', v_day)::date;
  v_prev_month date := (date_trunc('month', v_day) - interval '1 month')::date;
  v_count integer := 0;
  v_today integer;
  v_overdue integer;
  v_tasks jsonb;
  v_rows jsonb;
  v_payload jsonb;
  r record;
  c record;
begin
  -- Sales (and admins who own tasks): today's tasks and overdue count, 09:00–11:59 IST.
  if v_hour between 9 and 11 then
    for r in select p.id from public.profiles p where p.is_active and p.role in ('sales', 'admin', 'super_admin') loop
      select count(*) filter (where f.due_at >= v_day_start and f.due_at < v_day_end),
             count(*) filter (where f.due_at < p_now)
        into v_today, v_overdue
      from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
      where f.assignee_id = r.id and f.state = 'pending';
      continue when v_today + v_overdue = 0;
      select coalesce(jsonb_agg(t order by t.due_at, t.id), '[]'::jsonb) into v_tasks from (
        select f.id, f.task, f.due_at, l.id as lead_id, l.name as lead_name, f.due_at < p_now as overdue
        from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
        where f.assignee_id = r.id and f.state = 'pending' and f.due_at < v_day_end
        order by f.due_at, f.id limit 10
      ) t;
      if private.enqueue_notification(r.id, 'digest_sales',
        jsonb_build_object('date', v_day, 'today', v_today, 'overdue', v_overdue, 'tasks', v_tasks),
        'digest_sales:' || v_day) then
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  for c in select x.id from public.companies x where x.archived_at is null order by x.created_at, x.id loop
    -- Admin team report, 20:00–22:59 IST.
    if v_hour between 20 and 22 then
      select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) into v_rows from (
        select p.display_name as name,
          (select count(*) from public.leads l where l.owner_id = p.id and l.archived_at is null
             and l.status not in ('won', 'lost')) as active,
          (select count(*) from public.leads l where l.owner_id = p.id
             and l.created_at >= v_day_start and l.created_at < v_day_end) as new_today,
          (select count(*) from public.follow_ups f where f.assignee_id = p.id and f.state = 'completed'
             and f.completed_at >= v_day_start and f.completed_at < v_day_end) as done_today,
          (select count(*) from public.follow_ups f join public.leads l on l.id = f.lead_id and l.archived_at is null
             where f.assignee_id = p.id and f.state = 'pending' and f.due_at < p_now) as overdue,
          (select count(*) from public.lead_activities a join public.leads l on l.id = a.lead_id
             where l.owner_id = p.id and a.type = 'status_changed' and coalesce(a.meta ->> 'to_kind', a.meta ->> 'to') = 'won'
               and a.created_at >= v_day_start and a.created_at < v_day_end) as won_today,
          (select count(*) from public.lead_activities a where a.actor_id = p.id
             and a.created_at >= v_day_start and a.created_at < v_day_end) as actions_today,
          (select max(a.created_at) from public.lead_activities a where a.actor_id = p.id) as last_activity
        from public.profiles p
        where p.is_active and p.role = 'sales' and p.company_id = c.id
      ) x;
      v_count := v_count + private.enqueue_for_company(c.id, array['admin']::public.app_role[], 'digest_admin',
        jsonb_build_object('date', v_day, 'rows', v_rows), 'digest_admin:' || v_day || ':' || c.id);
    end if;

  end loop;

  -- Monthly finance summary for the previous month, per set of books, 1st of the month 09:00–11:59 IST.
  if extract(day from v_local) = 1 and v_hour between 9 and 11 then
    for c in
      select g.id as group_id, (select x.id from public.companies x where x.finance_group_id = g.id and x.archived_at is null
                                order by x.created_at, x.id limit 1) as company_id,
        (select array_agg(x.id) from public.companies x where x.finance_group_id = g.id and x.archived_at is null) as ids
      from public.finance_groups g
      where exists (select 1 from public.companies x where x.finance_group_id = g.id and x.archived_at is null)
    loop
      select jsonb_build_object(
        'month', to_char(v_prev_month, 'YYYY-MM'),
        'expense_total', coalesce((select sum(e.amount) from public.expenses e where e.company_id = any(c.ids) and e.archived_at is null
          and e.expense_date >= v_prev_month and e.expense_date < v_month_start), 0),
        'expense_count', (select count(*) from public.expenses e where e.company_id = any(c.ids) and e.archived_at is null
          and e.expense_date >= v_prev_month and e.expense_date < v_month_start),
        'categories', coalesce((select jsonb_agg(x order by x.total desc) from (
          select e.category, sum(e.amount) as total from public.expenses e
          where e.company_id = any(c.ids) and e.archived_at is null and e.expense_date >= v_prev_month and e.expense_date < v_month_start
          group by e.category) x), '[]'::jsonb),
        'capital_total', coalesce((select sum(k.amount) from public.capital_entries k where k.company_id = any(c.ids) and k.archived_at is null
          and k.entry_date >= v_prev_month and k.entry_date < v_month_start), 0)
      ) into v_payload;
      v_count := v_count + private.enqueue_for_books(c.company_id, 'digest_finance',
        v_payload, 'digest_finance:' || to_char(v_prev_month, 'YYYY-MM') || ':' || c.group_id);
    end loop;
  end if;
  return v_count;
end $$;

revoke all on function private.enqueue_for_books(uuid, text, jsonb, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.finance_groups, public.expense_categories from anon, authenticated;
grant select on public.expense_categories to authenticated;

-- Entries name their company (within the books) and their category by id; category (the name) follows.
revoke insert, update on public.expenses from authenticated;
grant insert (expense_date, category_id, category, amount, description, created_by, payment_mode, item, quantity, company_id)
  on public.expenses to authenticated;
grant update (expense_date, category_id, category, amount, description, archived_at, payment_mode, item, quantity, company_id)
  on public.expenses to authenticated;
grant insert (company_id), update (company_id) on public.capital_entries to authenticated;

revoke all on function
  private.companies_new_finance_group(),
  private.finance_group_id(),
  private.finance_company_ids(),
  private.can_edit_finance(),
  private.expense_category_sync(),
  private.move_company_books(uuid, uuid),
  public.resolve_expense_category(uuid, text),
  public.update_expense_category(uuid, text, boolean),
  public.merge_finance(uuid[], uuid[]),
  public.split_finance(uuid),
  public.set_finance_editors(uuid[]),
  public.super_finance_groups(),
  public.finance_context(),
  public.finance_company_split(date, date)
from public, anon;

grant execute on function private.finance_group_id(), private.finance_company_ids(), private.can_edit_finance() to authenticated, service_role;
grant execute on function
  public.resolve_expense_category(uuid, text),
  public.update_expense_category(uuid, text, boolean),
  public.merge_finance(uuid[], uuid[]),
  public.split_finance(uuid),
  public.set_finance_editors(uuid[]),
  public.super_finance_groups(),
  public.finance_context(),
  public.finance_company_split(date, date)
to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.expense_categories;
  end if;
end $$;
