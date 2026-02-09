-- Enable pg_cron extension (must be enabled in Supabase Dashboard first)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Daily cleanup job: purge soft-deleted items (7 days), lists (30 days), stale pending collaborators (30 days)
SELECT cron.schedule(
  'cleanup-soft-deletes',
  '0 3 * * *', -- Daily at 3 AM UTC
  $$
    -- Purge soft-deleted items older than 7 days
    DELETE FROM items WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '7 days';

    -- Purge soft-deleted lists (and remaining items via CASCADE) older than 30 days
    DELETE FROM lists WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days';

    -- Clean up stale pending collaborator requests older than 30 days
    DELETE FROM collaborators WHERE status = 'pending' AND created_at < now() - interval '30 days';
  $$
);
