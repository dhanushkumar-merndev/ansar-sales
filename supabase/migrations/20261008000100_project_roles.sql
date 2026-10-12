-- ---------------------------------------------------------------------------
-- Project roles (Star Gardens): enum values are added on their own, because a
-- new value cannot be used in the transaction that adds it.
--   architect_manager  — runs site visits, manages designers, approves drawings
--   landscape_designer — prepares layouts, decks, BOQs and drawings
--   execution          — runs the site: logs, BOQ progress, snags
-- ---------------------------------------------------------------------------
alter type public.app_role add value if not exists 'architect_manager';
alter type public.app_role add value if not exists 'landscape_designer';
alter type public.app_role add value if not exists 'execution';
