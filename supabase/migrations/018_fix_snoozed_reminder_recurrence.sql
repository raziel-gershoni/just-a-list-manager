-- Fix: cancel spurious recurring reminders spawned by snoozed reminders.
-- When a recurring reminder was snoozed, it kept its recurrence flag, causing
-- a duplicate recurrence chain when it re-fired. For each (item_id, created_by,
-- recurrence) group with multiple active rows, keep the oldest and cancel the rest.

WITH ranked AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY item_id, created_by, recurrence
      ORDER BY created_at ASC
    ) AS rn
  FROM item_reminders
  WHERE recurrence IS NOT NULL
    AND sent_at IS NULL
    AND cancelled_at IS NULL
)
UPDATE item_reminders
SET cancelled_at = now()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
