CREATE OR REPLACE FUNCTION find_fuzzy_items(
  p_list_id UUID,
  p_search_text TEXT,
  p_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  completed BOOLEAN,
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  "position" INTEGER
) AS $$
  SELECT i.id, i.text, i.completed, i.completed_at, i.deleted_at, i.position
  FROM items i
  WHERE i.list_id = p_list_id
    AND similarity(i.text, p_search_text) > p_threshold
    AND i.completed = true
    AND i.deleted_at IS NULL
  ORDER BY similarity(i.text, p_search_text) DESC
  LIMIT 10;
$$ LANGUAGE sql SECURITY DEFINER STABLE;
