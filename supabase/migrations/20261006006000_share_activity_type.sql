-- Main-timeline event for the customer's first open of a lead's document link.
-- Separate migration: an enum value cannot be used in the transaction that adds it.
alter type public.lead_activity_type add value if not exists 'share_opened';
