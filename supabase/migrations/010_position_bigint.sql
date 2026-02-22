-- Migration 010: Change position column from INTEGER to BIGINT
-- Reason: Client-side optimistic creates use Date.now() as position (~1.74 trillion),
-- which overflows PostgreSQL INTEGER (max 2,147,483,647), causing 500 errors.
--
-- Rollback (only safe if no BIGINT-range values have been inserted):
--   ALTER TABLE items ALTER COLUMN position TYPE INTEGER;
--   Then re-create both find_fuzzy_items overloads with "position" INTEGER.

-- ============================================================
-- 1. Widen position column to BIGINT
-- ============================================================

ALTER TABLE items ALTER COLUMN position TYPE BIGINT;

-- ============================================================
-- 2. Drop existing find_fuzzy_items overloads (return type change
--    requires DROP + CREATE, not CREATE OR REPLACE)
-- ============================================================

DROP FUNCTION IF EXISTS find_fuzzy_items(UUID, TEXT, TIMESTAMPTZ, FLOAT);
DROP FUNCTION IF EXISTS find_fuzzy_items(UUID, TEXT, FLOAT);

-- ============================================================
-- 3. Re-create find_fuzzy_items overloads with BIGINT return type
--    (Supersedes versions from migrations 001, 004, and 008)
-- ============================================================

-- find_fuzzy_items (4-param overload with p_since)
CREATE FUNCTION find_fuzzy_items(
  p_list_id UUID,
  p_search_text TEXT,
  p_since TIMESTAMPTZ,
  p_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  completed BOOLEAN,
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  "position" BIGINT
) AS $$
  SELECT i.id, i.text, i.completed, i.completed_at, i.deleted_at, i.position
  FROM items i
  WHERE i.list_id = p_list_id
    AND similarity(i.text, p_search_text) > p_threshold
    AND (
      (i.completed = true AND i.deleted_at IS NULL)
      OR (i.deleted_at IS NOT NULL AND i.deleted_at >= p_since)
    )
  ORDER BY similarity(i.text, p_search_text) DESC
  LIMIT 10;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;

-- find_fuzzy_items (3-param overload)
CREATE FUNCTION find_fuzzy_items(
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
  "position" BIGINT
) AS $$
  SELECT i.id, i.text, i.completed, i.completed_at, i.deleted_at, i.position
  FROM items i
  WHERE i.list_id = p_list_id
    AND similarity(i.text, p_search_text) > p_threshold
    AND i.completed = true
    AND i.deleted_at IS NULL
  ORDER BY similarity(i.text, p_search_text) DESC
  LIMIT 10;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;
