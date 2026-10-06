-- Ads team roles. Their own migration because a new enum value cannot be used in the
-- transaction that adds it.
--   ads_manager: works across the companies the super admin assigns; sees ads only.
--   client:      an ads client's read-only portal login.
alter type public.app_role add value if not exists 'ads_manager';
alter type public.app_role add value if not exists 'client';
