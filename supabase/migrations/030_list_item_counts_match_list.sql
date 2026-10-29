-- Home card counts match the list's own sections (docs/superpowers/specs/2026-10-29-sync-engine-repair-design.md,
-- owner decision 4):
-- - active_count: a skipped ("Not available") item sits in its own section, not with the items still to buy.
-- - completed_count: a parked recurring item waits in the Recurring drawer, not under Completed.
-- Same name, arguments, return type and attributes as migration 008, so CREATE OR REPLACE keeps its
-- grants and the lists route reads it unchanged. Safe to re-run: no BEGIN/COMMIT, nothing dropped.
CREATE OR REPLACE FUNCTION get_list_item_counts(p_list_ids UUID[])
RETURNS TABLE (
  list_id UUID,
  active_count BIGINT,
  completed_count BIGINT
) AS $$
  SELECT
    i.list_id,
    COUNT(*) FILTER (WHERE i.completed = false AND i.skipped_at IS NULL) AS active_count,
    COUNT(*) FILTER (WHERE i.completed = true AND i.recurring = false) AS completed_count
  FROM items i
  WHERE i.list_id = ANY(p_list_ids)
    AND i.deleted_at IS NULL
  GROUP BY i.list_id;
$$ LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public;
