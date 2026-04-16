-- Hourly digest cron: sends morning (8am local) and evening (9pm local) summaries.
-- Uses the same vault secrets as 016_reminder_cron.sql (app_url, cron_secret).

SELECT cron.schedule(
  'reminder-digest',
  '0 * * * *',
  $$
    SELECT net.http_get(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'app_url' LIMIT 1) || '/api/cron/digest',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
      )
    );
  $$
);
