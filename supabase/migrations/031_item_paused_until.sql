-- "Not needed this week" (docs/superpowers/specs/2026-11-07-not-needed-this-week-design.md): when a
-- recurring grocery staple the household skipped for the week comes back. Null when not paused.
-- No index: nothing on the server filters on it; the client compares it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ;
