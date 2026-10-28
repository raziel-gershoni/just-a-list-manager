-- Sunset reminders, release 1 (docs/superpowers/specs/2026-10-28-sunset-reminders-design.md).
-- Safe to re-run: scripts/migrate.mjs records a file in a separate step after running it, so
-- there is no BEGIN/COMMIT here and each statement does nothing the second time.
-- item_reminders and users.timezone stay until migration 029: the old code that keeps serving
-- during this deploy still reads both.

-- 1. Soft-delete every reminders list the way the app's own DELETE does (only lists.deleted_at).
--    Archived and shared lists are included. The cleanup-soft-deletes job hard-deletes them,
--    with their items, 30 days later.
UPDATE lists SET deleted_at = now() WHERE type = 'reminders' AND deleted_at IS NULL;

-- 2. Stop the two reminder cron jobs (016, 017). The filtered form removes only jobs that exist;
--    unscheduling by name raises an error for a missing job, and that would fail the deploy.
--    cron.job is row-level secured, so a role that cannot see the jobs removes none. The NOTICE
--    puts the count in the build log, and SELECT jobname FROM cron.job confirms it after deploy.
DO $$
DECLARE
  v_removed BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('process-reminders', 'reminder-digest');
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RAISE NOTICE '[028] unscheduled % reminder cron job(s)', v_removed;
  ELSE
    RAISE NOTICE '[028] pg_cron is not installed; no reminder cron jobs to unschedule';
  END IF;
END $$;
