-- Fix type mismatch: items.idempotency_key is VARCHAR(64) but
-- insert_item_if_under_limit RETURNS TABLE declares it as TEXT.
-- Widen the column to TEXT so the types match.
ALTER TABLE items ALTER COLUMN idempotency_key TYPE TEXT;
