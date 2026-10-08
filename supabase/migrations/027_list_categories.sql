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
-- saw, is not hand-placed, is live, and (pending mode) is still uncategorized, and only
-- to a category of the same list. A late result can never overwrite a newer edit or move.
CREATE OR REPLACE FUNCTION apply_item_categories(
  p_list_id UUID,
  p_assignments JSONB,
  p_only_null BOOLEAN
) RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE items i
  SET category_id = a.category_id
  FROM jsonb_to_recordset(p_assignments) AS a(id UUID, "text" TEXT, category_id UUID)
  WHERE i.id = a.id
    AND i.list_id = p_list_id
    AND i."text" = a."text"
    AND NOT i.category_locked
    AND i.deleted_at IS NULL
    AND (NOT p_only_null OR i.category_id IS NULL)
    AND EXISTS (
      SELECT 1 FROM list_categories c WHERE c.id = a.category_id AND c.list_id = p_list_id
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION apply_item_categories(UUID, JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_item_categories(UUID, JSONB, BOOLEAN) TO service_role;
