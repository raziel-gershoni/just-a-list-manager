-- Add idempotency_key column for safe mutation replay
-- Nullable so existing items aren't affected
ALTER TABLE items ADD COLUMN idempotency_key VARCHAR(64);

-- Partial unique constraint scoped to list_id (only for non-null keys)
CREATE UNIQUE INDEX idx_items_idempotency_key
  ON items (list_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
