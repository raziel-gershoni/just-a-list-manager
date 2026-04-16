-- Enable pg_net for HTTP requests from PostgreSQL
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Per-minute cron job to process due reminders.
-- Calls our API endpoint, authenticated with a secret stored in Supabase Vault.
--
-- One-time setup via Supabase Dashboard SQL Editor:
--
--   SELECT vault.create_secret('https://just-a-list-manager.vercel.app', 'app_url');
--   SELECT vault.create_secret('YOUR_CRON_SECRET_VALUE', 'cron_secret');
--
-- Then set the same cron_secret value as CRON_SECRET env var in Vercel.

SELECT cron.schedule(
  'process-reminders',
  '* * * * *',
  $$
    SELECT net.http_get(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_url' LIMIT 1) || '/api/cron/reminders',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
      )
    );
  $$
);
