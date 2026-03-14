-- Atomic item count check + insert to prevent race condition on 500-item limit
CREATE OR REPLACE FUNCTION insert_item_if_under_limit(
  p_list_id UUID,
  p_text TEXT,
  p_position BIGINT,
  p_created_by UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_item_limit INT DEFAULT 500
)
RETURNS TABLE (
  id UUID,
  "text" TEXT,
  list_id UUID,
  "position" BIGINT,
  completed BOOLEAN,
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  skipped_at TIMESTAMPTZ,
  created_by UUID,
  edited_by UUID,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ
) AS $$
DECLARE
  v_count INT;
BEGIN
  -- Lock the list row to serialize concurrent inserts
  PERFORM 1 FROM lists WHERE lists.id = p_list_id FOR UPDATE;

  -- Count active items (not soft-deleted)
  SELECT COUNT(*) INTO v_count
  FROM items
  WHERE items.list_id = p_list_id AND items.deleted_at IS NULL;

  IF v_count >= p_item_limit THEN
    RAISE EXCEPTION 'ITEM_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  INSERT INTO items (list_id, "text", "position", created_by, idempotency_key)
  VALUES (p_list_id, p_text, p_position, p_created_by, p_idempotency_key)
  RETURNING items.id, items."text", items.list_id, items."position", items.completed,
            items.completed_at, items.deleted_at, items.skipped_at,
            items.created_by, items.edited_by, items.idempotency_key, items.created_at;
END;
$$ LANGUAGE plpgsql;
