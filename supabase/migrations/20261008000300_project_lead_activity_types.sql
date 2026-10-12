-- Lead timeline events for the Star Gardens flow (added on their own: enum values can't be used
-- in the transaction that adds them).
alter type public.lead_activity_type add value if not exists 'handed_off';
alter type public.lead_activity_type add value if not exists 'project_created';
