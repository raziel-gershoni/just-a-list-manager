-- Fix Realtime CHANNEL_ERROR — two problems:
--
-- 1. get_user_id_from_jwt() did a DB lookup (SELECT FROM users) which fails
--    in the Realtime context. Fixed: use auth.uid() directly.
--
-- 2. RLS policies have circular cross-table subqueries:
--      items policy → queries lists (RLS) → lists policy → queries collaborators (RLS)
--      → collaborators policy → queries lists (RLS) → ...
--    Supabase Realtime cannot evaluate these nested RLS chains.
--    Fixed: wrap access check in a SECURITY DEFINER function that bypasses
--    RLS on inner tables, breaking the circular dependency.

-- Step 1: Fix get_user_id_from_jwt() to use auth.uid() (no DB lookup)
CREATE OR REPLACE FUNCTION get_user_id_from_jwt()
RETURNS UUID AS $$
  SELECT auth.uid();
$$ LANGUAGE sql STABLE;

-- Step 2: Create a SECURITY DEFINER function that returns all list IDs
-- the current user can access. Runs as function owner (superuser),
-- so inner queries on lists/collaborators bypass RLS entirely.
CREATE OR REPLACE FUNCTION get_accessible_list_ids()
RETURNS SETOF UUID AS $$
  SELECT id FROM lists WHERE owner_id = auth.uid()
  UNION
  SELECT list_id FROM collaborators
  WHERE user_id = auth.uid() AND status = 'approved';
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Step 3: Replace all RLS policies to use get_accessible_list_ids()
-- instead of inline cross-table subqueries.

-- Lists: user can see lists they own or collaborate on
DROP POLICY IF EXISTS "lists_select_own_or_collab" ON lists;
CREATE POLICY "lists_select_own_or_collab" ON lists FOR SELECT USING (
  id IN (SELECT get_accessible_list_ids())
);

-- Items: user can see items in lists they have access to
DROP POLICY IF EXISTS "items_select_via_list_access" ON items;
CREATE POLICY "items_select_via_list_access" ON items FOR SELECT USING (
  list_id IN (SELECT get_accessible_list_ids())
);

-- Collaborators: user can see their own records or records for lists they can access
DROP POLICY IF EXISTS "collaborators_select_own" ON collaborators;
CREATE POLICY "collaborators_select_own" ON collaborators FOR SELECT USING (
  user_id = auth.uid()
  OR list_id IN (SELECT get_accessible_list_ids())
);
