-- New timeline event types. Kept in their own migration: a value added to an enum
-- cannot be used in the same transaction that adds it.
alter type public.lead_activity_type add value if not exists 'call_logged';
alter type public.lead_activity_type add value if not exists 'files_shared';
alter type public.lead_activity_type add value if not exists 'share_revoked';
