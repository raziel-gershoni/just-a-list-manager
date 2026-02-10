-- Required for Supabase Realtime + RLS to work correctly.
-- Without REPLICA IDENTITY FULL, DELETE events only contain primary key columns
-- in the `old` record, which prevents Realtime from evaluating RLS policies.
-- This causes collaborators to silently miss delete events.

ALTER TABLE items REPLICA IDENTITY FULL;
ALTER TABLE lists REPLICA IDENTITY FULL;
ALTER TABLE collaborators REPLICA IDENTITY FULL;
