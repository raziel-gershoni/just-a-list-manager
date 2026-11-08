-- Item sheet and quantity (docs/superpowers/specs/2026-11-08-item-sheet-and-quantity-design.md):
-- an optional free-text amount on a grocery item ("2", "1.5 kg", "3 packs"). Null when there is
-- none, never ''. The name (text) stays the item's identity; nothing compares quantities.
ALTER TABLE items ADD COLUMN IF NOT EXISTS quantity TEXT
  CHECK (quantity IS NULL OR char_length(quantity) BETWEEN 1 AND 30);
