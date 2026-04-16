CREATE TABLE item_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remind_at TIMESTAMPTZ NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT false,
  recurrence TEXT,
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_item_reminders_due
  ON item_reminders (remind_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX idx_item_reminders_item
  ON item_reminders (item_id) WHERE sent_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE item_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own reminders"
  ON item_reminders FOR ALL
  USING (created_by = auth.uid());
