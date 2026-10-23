-- ---------------------------------------------------------------------------
-- The signed-in user's session in one request (src/lib/auth.ts getCurrentProfile), instead of three.
--
-- Every page render, preload and server action reads the profile, the companies the user can see and
-- where they work now (my_context). my_session returns exactly those three reads: same columns, same
-- filter and order, and security invoker, so the same RLS policies decide what comes back.
-- Additive only: the app falls back to the three reads while this function is missing.
-- ---------------------------------------------------------------------------

create or replace function public.my_session()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'profile', (
      select to_jsonb(p) from (
        select id, username, display_name, role, extra_roles, is_active from public.profiles where id = (select auth.uid())
      ) p
    ),
    'companies', coalesce((
      select jsonb_agg(to_jsonb(c) - 'created_at' order by c.created_at, c.id) from (
        select id, name, brand_highlight, logo_path, features, parent_company_id, created_at from public.companies where archived_at is null
      ) c
    ), '[]'::jsonb),
    'context', public.my_context()
  )
$$;

revoke all on function public.my_session() from public, anon;
grant execute on function public.my_session() to authenticated;
