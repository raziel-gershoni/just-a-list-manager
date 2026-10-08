-- Grocery auto-categories (docs/superpowers/specs/2026-10-08-grocery-auto-categories-design.md).
-- Per-list store sections the AI creates and the household edits. Items point at one;
-- category_locked marks an item a person placed by hand, which the AI never moves.

CREATE TABLE IF NOT EXISTS list_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  name_en TEXT NOT NULL,
  name_he TEXT NOT NULL,
  name_ru TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_list_categories_list ON list_categories(list_id, position);

-- Same read rule as items; all writes go through the service role.
ALTER TABLE list_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "list_categories_select_via_list_access" ON list_categories;
CREATE POLICY "list_categories_select_via_list_access" ON list_categories FOR SELECT USING (
  list_id IN (SELECT get_accessible_list_ids())
);

-- Collaborators see renames, reorders and new categories live; DELETE events need the
-- full old row to carry list_id through the list filter.
ALTER TABLE list_categories REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'list_categories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE list_categories;
  END IF;
END $$;

ALTER TABLE items ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES list_categories(id) ON DELETE SET NULL;
ALTER TABLE items ADD COLUMN IF NOT EXISTS category_locked BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_items_uncategorized
  ON items(list_id) WHERE category_id IS NULL AND deleted_at IS NULL;
-- ON DELETE SET NULL looks items up by category_id when a category is deleted.
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id) WHERE category_id IS NOT NULL;

-- Write AI results in one statement, only where the item still has the text the AI
-- saw, is not hand-placed (or was, but its category is gone), is live, and (pending
-- mode) is still uncategorized, and only to a category of the same list. A late result
-- can never overwrite a newer edit or move.
CREATE OR REPLACE FUNCTION apply_item_categories(
  p_list_id UUID,
  p_assignments JSONB,
  p_only_null BOOLEAN
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
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

REVOKE ALL ON FUNCTION apply_item_categories(UUID, JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_item_categories(UUID, JSONB, BOOLEAN) TO service_role;

-- A re-scan the user asked for (a new category) that could not run yet: the AI was refused or
-- failed. Cleared by the first re-scan that gets an AI answer.
ALTER TABLE lists ADD COLUMN IF NOT EXISTS categories_rescan_at TIMESTAMPTZ;

-- Setting or clearing only that flag must not bump lists.updated_at: it orders lists the user
-- hasn't dragged on the home screen, and a background re-scan should not move a list there.
-- Any other change still bumps it (an explicit updated_at in the same UPDATE is kept as given).
DROP TRIGGER IF EXISTS trg_lists_updated_at ON lists;
CREATE TRIGGER trg_lists_updated_at BEFORE UPDATE ON lists FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'categories_rescan_at' - 'updated_at') IS DISTINCT FROM (to_jsonb(NEW) - 'categories_rescan_at' - 'updated_at'))
  EXECUTE FUNCTION update_updated_at();

-- Insert a category under the list row lock: cap check, placement and shift happen against
-- current positions, so concurrent adds, AI inserts and reorders cannot tie or overwrite.
-- p_placement: 'first' | 'after' (p_after_id) | 'last'. An 'after' whose category is gone
-- falls back to 'last'. Returns no row when the list already has p_max categories.
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
  PERFORM 1 FROM lists WHERE id = p_list_id FOR UPDATE;
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

-- Renumber a list's categories in one statement under the same lock. False (nothing written)
-- unless p_ordered_ids is exactly the list's categories, each once.
CREATE OR REPLACE FUNCTION reorder_list_categories(p_list_id UUID, p_ordered_ids UUID[])
RETURNS BOOLEAN AS $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM 1 FROM lists WHERE id = p_list_id FOR UPDATE;
  SELECT count(*) INTO v_count FROM list_categories WHERE list_id = p_list_id;
  IF v_count <> COALESCE(cardinality(p_ordered_ids), 0)
     OR (SELECT count(DISTINCT x) FROM unnest(p_ordered_ids) AS x) <> v_count
     OR EXISTS (
       SELECT 1 FROM unnest(p_ordered_ids) AS x
       WHERE NOT EXISTS (SELECT 1 FROM list_categories c WHERE c.id = x AND c.list_id = p_list_id)
     ) THEN
    RETURN false;
  END IF;
  UPDATE list_categories c
  SET position = o.ord - 1
  FROM unnest(p_ordered_ids) WITH ORDINALITY AS o(id, ord)
  WHERE c.id = o.id AND c.list_id = p_list_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql SET search_path = public;

REVOKE ALL ON FUNCTION insert_list_category(UUID, TEXT, TEXT, TEXT, UUID, TEXT, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION insert_list_category(UUID, TEXT, TEXT, TEXT, UUID, TEXT, UUID, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION reorder_list_categories(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reorder_list_categories(UUID, UUID[]) TO service_role;
