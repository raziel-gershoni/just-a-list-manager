-- The series slot a recurring reminder belongs to, recorded only when a snooze
-- moves remind_at off it. NULL means remind_at IS the anchor.
--
-- Why a column: the next occurrence is computed when Done is tapped, from the
-- reminder's remind_at. Snooze overwrites remind_at in place, so without this a
-- 30-minute snooze on a 09:00 daily reminder would move every future occurrence
-- to 09:30. Every other writer of remind_at inserts a fresh row (a deliberate
-- time change cancels the old reminder and creates a new one, which correctly
-- becomes the new anchor), so only snooze needs to record one.
ALTER TABLE item_reminders ADD COLUMN IF NOT EXISTS anchor_at TIMESTAMPTZ;
