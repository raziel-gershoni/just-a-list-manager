-- Users (created on first /start or Mini App open)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  language TEXT DEFAULT 'en' CHECK (language IN ('en', 'he', 'ru')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Lists (soft delete via deleted_at — 30 day retention)
CREATE TABLE lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) <= 100),
  owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Items
CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (char_length(text) <= 500),
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  position INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Collaborators (sharing)
CREATE TABLE collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(list_id, user_id)
);

-- Invite links
CREATE TABLE invite_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID REFERENCES lists(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('view', 'edit')),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_items_list_id ON items(list_id);
CREATE INDEX idx_items_completed ON items(list_id, completed, completed_at DESC);
CREATE INDEX idx_items_deleted ON items(list_id, deleted_at);
CREATE INDEX idx_collaborators_list ON collaborators(list_id, status);
CREATE INDEX idx_collaborators_user ON collaborators(user_id, status);
CREATE INDEX idx_invite_links_token ON invite_links(token);
CREATE INDEX idx_users_telegram_id ON users(telegram_id);

-- pg_trgm extension for text similarity search (voice fuzzy matching)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_items_text_trgm ON items USING GIN (text gin_trgm_ops);

-- updated_at auto-update trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_lists_updated_at BEFORE UPDATE ON lists FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_items_updated_at BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_collaborators_updated_at BEFORE UPDATE ON collaborators FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS Policies (for Realtime subscriptions via custom JWT)
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaborators ENABLE ROW LEVEL SECURITY;

-- Helper function to get current user's internal UUID from JWT claim
CREATE OR REPLACE FUNCTION get_user_id_from_jwt()
RETURNS UUID AS $$
  SELECT id FROM users WHERE telegram_id = (auth.jwt() ->> 'telegram_user_id')::BIGINT LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Lists: user can SELECT if they are the owner or an approved collaborator
CREATE POLICY "lists_select_own_or_collab" ON lists FOR SELECT USING (
  owner_id = get_user_id_from_jwt()
  OR id IN (
    SELECT list_id FROM collaborators
    WHERE user_id = get_user_id_from_jwt()
    AND status = 'approved'
  )
);

-- Items: user can SELECT if they have access to the parent list
CREATE POLICY "items_select_via_list_access" ON items FOR SELECT USING (
  list_id IN (
    SELECT id FROM lists WHERE owner_id = get_user_id_from_jwt()
    UNION
    SELECT list_id FROM collaborators
    WHERE user_id = get_user_id_from_jwt()
    AND status = 'approved'
  )
);

-- RPC: Get item counts (active + completed) for multiple lists in one query
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
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- RPC: Fuzzy item search using pg_trgm similarity
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
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Collaborators: user can SELECT their own records or records for lists they own
CREATE POLICY "collaborators_select_own" ON collaborators FOR SELECT USING (
  user_id = get_user_id_from_jwt()
  OR list_id IN (SELECT id FROM lists WHERE owner_id = get_user_id_from_jwt())
);
