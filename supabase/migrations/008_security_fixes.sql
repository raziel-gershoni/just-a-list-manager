-- Migration 008: Security fixes
-- Addresses Supabase Security Advisor findings:
--   1. RLS disabled on users, invite_links, _migrations
--   2. Function search_path not set on 6 functions
--   3. pg_trgm extension in public schema

-- ============================================================
-- 1. Enable RLS on unprotected tables
--    No policies needed — all access is via service-role client
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE _migrations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. Move pg_trgm extension out of public schema
-- ============================================================

CREATE SCHEMA IF NOT EXISTS extensions;
ALTER EXTENSION pg_trgm SET SCHEMA extensions;

-- ============================================================
-- 3. Re-create functions with search_path set
-- ============================================================

-- update_updated_at: trigger function
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- get_user_id_from_jwt: returns current user UUID from JWT
CREATE OR REPLACE FUNCTION get_user_id_from_jwt()
RETURNS UUID AS $$
  SELECT auth.uid();
$$ LANGUAGE sql STABLE SET search_path = public;

-- get_accessible_list_ids: returns list IDs the current user can access
CREATE OR REPLACE FUNCTION get_accessible_list_ids()
RETURNS SETOF UUID AS $$
  SELECT id FROM lists WHERE owner_id = auth.uid()
  UNION
  SELECT list_id FROM collaborators
  WHERE user_id = auth.uid() AND status = 'approved';
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- get_list_item_counts: returns active/completed counts per list
CREATE OR REPLACE FUNCTION get_list_item_counts(p_list_ids UUID[])
RETURNS TABLE (
  list_id UUID,
  active_count BIGINT,
  completed_count BIGINT
) AS $$
  SELECT
    i.list_id,
    COUNT(*) FILTER (WHERE i.completed = false) AS active_count,
    COUNT(*) FILTER (WHERE i.completed = true) AS completed_count
  FROM items i
  WHERE i.list_id = ANY(p_list_ids)
    AND i.deleted_at IS NULL
  GROUP BY i.list_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;

-- find_fuzzy_items (4-param overload with p_since): from migration 001
CREATE OR REPLACE FUNCTION find_fuzzy_items(
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
  "position" INTEGER
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

-- find_fuzzy_items (3-param overload): from migration 004
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
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public, extensions;
