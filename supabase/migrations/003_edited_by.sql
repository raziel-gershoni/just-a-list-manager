ALTER TABLE items ADD COLUMN edited_by UUID REFERENCES users(id);
