ALTER TABLE items ADD COLUMN recurring BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX idx_items_recurring ON items(list_id) WHERE recurring = true;
