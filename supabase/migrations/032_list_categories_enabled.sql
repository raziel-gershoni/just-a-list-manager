-- A per-list switch for grocery categories (docs/superpowers/specs/2026-11-08-categories-switch-design.md).
-- Off deletes the list's categories and every item's placement; on starts sorting from zero.
ALTER TABLE lists ADD COLUMN IF NOT EXISTS categories_enabled BOOLEAN NOT NULL DEFAULT true;

-- The switch and its cleanup in one transaction. The list row is updated first, so this holds the
-- row lock the categorizer's writes check the switch under: a write either lands before the
-- cleanup, which then removes it, or waits and sees the switch off. Categories are deleted before
-- the items are touched, the order a category delete takes, so this can't deadlock with a category
-- delete, or with the categorizer's writes, which take the list row first.
-- A hand move of an item (item PATCH categoryId) racing an off can deadlock: the move holds the item
-- and waits for its category, the off the reverse. Postgres aborts one side, and both recover: the
-- failed off rolls back with a toast and re-reads, and the queued move retries and is then dropped
-- as an unknown category.
-- On only sets the flag: a repeated "on" must never wipe a list that is sorted.
CREATE OR REPLACE FUNCTION set_list_categories_enabled(p_list_id UUID, p_enabled BOOLEAN)
RETURNS SETOF lists AS $$
BEGIN
  UPDATE lists
  SET categories_enabled = p_enabled,
      categories_rescan_at = CASE WHEN p_enabled THEN categories_rescan_at ELSE NULL END
  WHERE id = p_list_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT p_enabled THEN
    -- ON DELETE SET NULL clears the items' category_id; the update then unlocks hand placements.
    DELETE FROM list_categories WHERE list_id = p_list_id;
    UPDATE items SET category_id = NULL, category_locked = false
    WHERE list_id = p_list_id AND (category_id IS NOT NULL OR category_locked);
  END IF;
  RETURN QUERY SELECT * FROM lists WHERE id = p_list_id;
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION set_list_categories_enabled(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION set_list_categories_enabled(UUID, BOOLEAN) TO service_role;

-- Write AI results in one statement, only where the item still has the text the AI
-- saw, is not hand-placed (or was, but its category is gone), is live, and (pending
-- mode) is still uncategorized, and only to a category of the same list. A late result
-- can never overwrite a newer edit or move. Writes nothing while the list's categories are off.
CREATE OR REPLACE FUNCTION apply_item_categories(
  p_list_id UUID,
  p_assignments JSONB,
  p_only_null BOOLEAN
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Categories turned off: write nothing. FOR SHARE waits for a cleanup holding the list row and
  -- then reads its result, and holds a cleanup back until this write is done.
  PERFORM 1 FROM lists WHERE id = p_list_id AND categories_enabled FOR SHARE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  UPDATE items i
  SET category_id = a.category_id, category_locked = false
  FROM jsonb_to_recordset(p_assignments) AS a(id UUID, "text" TEXT, category_id UUID)
  WHERE i.id = a.id
    AND i.list_id = p_list_id
    AND i."text" = a."text"
    AND (NOT i.category_locked OR i.category_id IS NULL)
    AND i.deleted_at IS NULL
    AND (NOT p_only_null OR i.category_id IS NULL)
    AND EXISTS (
      SELECT 1 FROM list_categories c WHERE c.id = a.category_id AND c.list_id = p_list_id
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Insert a category under the list row lock: cap check, placement and shift happen against
-- current positions, so concurrent adds, AI inserts and reorders cannot tie or overwrite.
-- p_placement: 'first' | 'after' (p_after_id) | 'last'. An 'after' whose category is gone
-- falls back to 'last'. Returns no row when the list already has p_max categories, or its
-- categories are off.
CREATE OR REPLACE FUNCTION insert_list_category(
  p_list_id UUID,
  p_name_en TEXT,
  p_name_he TEXT,
  p_name_ru TEXT,
  p_created_by UUID,
  p_placement TEXT,
  p_after_id UUID,
  p_max INTEGER
) RETURNS SETOF list_categories AS $$
DECLARE
  v_count INTEGER;
  v_pos INTEGER;
BEGIN
  -- The same lock as before; a list with categories off gets no new category.
  PERFORM 1 FROM lists WHERE id = p_list_id AND categories_enabled FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_count FROM list_categories WHERE list_id = p_list_id;
  IF v_count >= p_max THEN
    RETURN;
  END IF;
  IF p_placement = 'first' THEN
    v_pos := 0;
  ELSIF p_placement = 'after' THEN
    SELECT c.position + 1 INTO v_pos FROM list_categories c WHERE c.id = p_after_id AND c.list_id = p_list_id;
  END IF;
  IF v_pos IS NULL THEN
    SELECT COALESCE(MAX(c.position) + 1, 0) INTO v_pos FROM list_categories c WHERE c.list_id = p_list_id;
  ELSE
    UPDATE list_categories SET position = position + 1 WHERE list_id = p_list_id AND position >= v_pos;
  END IF;
  RETURN QUERY
    INSERT INTO list_categories (list_id, name_en, name_he, name_ru, position, created_by)
    VALUES (p_list_id, p_name_en, p_name_he, p_name_ru, v_pos, p_created_by)
    RETURNING *;
END;
$$ LANGUAGE plpgsql SET search_path = public;
