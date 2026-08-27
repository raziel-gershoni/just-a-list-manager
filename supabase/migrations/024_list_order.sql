-- Per-user manual ordering of the home screen list.
-- Sparse: a row exists only once a user has actually dragged a list.
-- Owner and collaborator are treated identically — `collaborators` has no
-- row for the owner, so it cannot carry the owner's own order.
CREATE TABLE list_order (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list_id  UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  position BIGINT NOT NULL,
  PRIMARY KEY (user_id, list_id)
);

-- The primary key already indexes (user_id, ...), which serves the only
-- read pattern: WHERE user_id = $1 AND list_id IN (...).

ALTER TABLE list_order ENABLE ROW LEVEL SECURITY;

CREATE POLICY "list_order_select_own" ON list_order FOR SELECT
  USING (user_id = auth.uid());

-- GET /api/lists filters lists on owner_id and there has never been an
-- index for it.
CREATE INDEX IF NOT EXISTS idx_lists_owner ON lists(owner_id) WHERE deleted_at IS NULL;
