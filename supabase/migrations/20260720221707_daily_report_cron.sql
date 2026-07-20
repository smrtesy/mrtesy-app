-- ============================================================
-- דוח יומי — weekly report cron (hourly at :20)
-- ============================================================
-- pg_cron POSTs hourly to the Railway backend's weekly-report job route. The
-- route itself decides who is due: for each user with the day-tool enabled it
-- checks it is Tuesday at the user's configured hour in THEIR timezone
-- (America/New_York by default) and that this week's report hasn't been sent
-- yet (once-per-week guard) before generating + delivering to the inbox.
-- Same Vault-secret pattern as the smrtBot crons; degrades to a no-op notice
-- when pg_cron/pg_net or the secrets are absent, so the migration chain never
-- breaks.
--
-- PROVISIONING (one-time): set two Vault secrets to the Railway backend's
-- values, mirroring smrtbot_cron_url/secret:
--   • smrttask_cron_url    — the backend base URL (e.g. https://<app>.up.railway.app)
--   • smrttask_cron_secret — the value of the backend's CRON_SECRET
--
--   SELECT vault.create_secret('https://<app>.up.railway.app', 'smrttask_cron_url');
--   SELECT vault.create_secret('<CRON_SECRET value>',          'smrttask_cron_secret');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[daily-report cron] pg_cron not installed — skipping schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[daily-report cron] pg_net not installed — skipping schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_secret') THEN
    RAISE NOTICE '[daily-report cron] Vault secrets smrttask_cron_url/secret not set — skipping schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('daily-report-weekly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-report-weekly');

  PERFORM cron.schedule(
    'daily-report-weekly',
    '20 * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_url')
                   || '/api/daily-report/jobs/weekly',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );
  RAISE NOTICE '[daily-report cron] scheduled daily-report-weekly (hourly at :20).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[daily-report cron] setup skipped: %', SQLERRM;
END$$;
