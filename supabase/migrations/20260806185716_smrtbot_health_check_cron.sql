-- ============================================================
-- smrtBot — daily credential health-check cron (07:00 America/New_York ≈ 11:00 UTC)
-- ============================================================
-- pg_cron POSTs once a day to the Railway job route /api/bot/jobs/health-check,
-- which probes every LIVE Meta bot's credentials against Meta (read-only GET,
-- no message sent). Any bot whose token/number Meta rejects raises ONE inbox +
-- push notification via reportError — so a revoked/expired token is caught the
-- next morning instead of by children hitting a dead bot. Same Vault-secret
-- pattern as the daily-summary / broadcasts crons; the route is derived from
-- smrtbot_cron_url by swapping the last path segment. Never breaks the chain.
--
-- Schedule: '0 11 * * *' UTC → 07:00 EDT (summer) / 06:00 EST (winter). Exact
-- minute is not important for a health probe; a fixed UTC hour avoids DST churn.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[smrtbot cron] pg_cron not installed — skipping health-check schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[smrtbot cron] pg_net not installed — skipping health-check schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_secret') THEN
    RAISE NOTICE '[smrtbot cron] Vault secrets smrtbot_cron_url/secret not set — skipping health-check schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('smrtbot-health-check')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtbot-health-check');

  PERFORM cron.schedule(
    'smrtbot-health-check',
    '0 11 * * *',
    $cron$
      SELECT net.http_post(
        url     := regexp_replace((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_url'), '/[^/]+$', '/health-check'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-smrtbot-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );
  RAISE NOTICE '[smrtbot cron] scheduled smrtbot-health-check (daily at 11:00 UTC).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[smrtbot cron] health-check setup skipped: %', SQLERRM;
END$$;
