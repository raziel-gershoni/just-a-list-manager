-- Fix Realtime CHANNEL_ERROR caused by get_user_id_from_jwt() doing a DB lookup.
--
-- The old implementation queried the users table to convert telegram_id -> UUID:
--   SELECT id FROM users WHERE telegram_id = (auth.jwt() ->> 'telegram_user_id')::BIGINT
--
-- This fails in the Supabase Realtime context because SECURITY DEFINER + cross-table
-- lookups during RLS evaluation cause the channel subscription to error out.
--
-- The fix: auth.uid() already returns the user UUID directly from the JWT `sub` claim
-- (set at token signing time in app/api/auth/token/route.ts), so no DB lookup is needed.

CREATE OR REPLACE FUNCTION get_user_id_from_jwt()
RETURNS UUID AS $$
  SELECT auth.uid();
$$ LANGUAGE sql STABLE;
