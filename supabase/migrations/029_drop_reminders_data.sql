-- Sunset reminders, release 2 (docs/superpowers/specs/2026-10-28-sunset-reminders-design.md).
-- Push only after release 1 (migration 028 plus the code removal) is live in production: the code
-- from before release 1 reads item_reminders and users.timezone, and release 1's code reads
-- neither. Safe to re-run: no BEGIN/COMMIT, and each statement does nothing the second time.

-- 1. Catch stragglers: a reminders list that an old app created during release 1's deploy window.
UPDATE lists SET deleted_at = now() WHERE type = 'reminders' AND deleted_at IS NULL;

-- 2. Retire the type. Every reminders list is soft-deleted by now. Making them regular lets the
--    CHECK hold for every row until cleanup-soft-deletes purges them.
UPDATE lists SET type = 'regular' WHERE type = 'reminders';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'lists_type_check' AND conrelid = 'public.lists'::regclass
  ) THEN
    ALTER TABLE lists ADD CONSTRAINT lists_type_check CHECK (type IN ('regular', 'grocery'));
  END IF;
END $$;

-- 3. Delete the reminder data. No CASCADE: nothing depends on either of them (migrations 014-026
--    add no view, trigger, function or publication entry for them), and an unexpected dependent
--    should fail the deploy loudly instead of being dropped along with them.
DROP TABLE IF EXISTS item_reminders;
ALTER TABLE users DROP COLUMN IF EXISTS timezone;
