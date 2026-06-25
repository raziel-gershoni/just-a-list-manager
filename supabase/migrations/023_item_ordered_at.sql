-- Items ordered online but not yet received ("On the way"). Mirrors skipped_at,
-- but never auto-resets. Grocery lists only (enforced client-side).
ALTER TABLE items ADD COLUMN ordered_at TIMESTAMPTZ;

CREATE INDEX idx_items_ordered_at ON items(list_id) WHERE ordered_at IS NOT NULL;
