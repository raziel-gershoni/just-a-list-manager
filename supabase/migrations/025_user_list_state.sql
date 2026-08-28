-- Archive is per-user, exactly like list order (024). Fold both into one
-- per-user state table rather than carry two tables keyed (user_id, list_id)
-- that every read would have to join together.
ALTER TABLE list_order RENAME TO user_list_state;

-- A list can be archived without ever having been dragged.
ALTER TABLE user_list_state ALTER COLUMN position DROP NOT NULL;

ALTER TABLE user_list_state ADD COLUMN archived_at TIMESTAMPTZ;

-- The primary key already serves (user_id, list_id) lookups; this serves
-- "which lists has this user archived".
CREATE INDEX IF NOT EXISTS idx_user_list_state_archived
  ON user_list_state(user_id) WHERE archived_at IS NOT NULL;

-- The rename carries RLS, policies, indexes and constraints across; only the
-- policy's name goes stale.
ALTER POLICY "list_order_select_own" ON user_list_state
  RENAME TO "user_list_state_select_own";
