ALTER TABLE items ADD COLUMN skipped_at TIMESTAMPTZ;
CREATE INDEX idx_items_skipped ON items(list_id, skipped_at) WHERE skipped_at IS NOT NULL;
