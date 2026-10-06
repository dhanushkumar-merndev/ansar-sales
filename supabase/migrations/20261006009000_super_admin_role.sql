-- Multi-company: a platform-wide role above the company admins. Its own migration because a
-- new enum value cannot be used in the transaction that adds it.
alter type public.app_role add value if not exists 'super_admin';
