-- ============================================================
-- Developer-access monitor — sweep cron (every 5 minutes)
-- ============================================================
-- pg_cron POSTs every 5 min to the Railway backend's sweep route, which pulls
-- postgres_logs for the `developer` DB role via the Management API, geo-locates
-- new client IPs, and writes anomalies to log_entries (level='error') so the
-- existing trg_notify_superadmins_on_error alert path fires. Detection only —
-- pgaudit already journals the activity (migration 20260806120000). Design:
-- docs/developer-access-monitor-plan.md.
--
-- Reuses the SAME Vault secrets as the daily-report cron
-- (smrttask_cron_url / smrttask_cron_secret) — no new provisioning needed. The
-- backend route checks x-cron-secret == CRON_SECRET, which mirrors
-- smrttask_cron_secret. Degrades to a no-op notice when pg_cron/pg_net or the
-- secrets are absent, so the migration chain never breaks.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[dev-access monitor cron] pg_cron not installed — skipping schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[dev-access monitor cron] pg_net not installed — skipping schedule.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_secret') THEN
    RAISE NOTICE '[dev-access monitor cron] Vault secrets smrttask_cron_url/secret not set — skipping schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('developer-access-monitor')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'developer-access-monitor');

  PERFORM cron.schedule(
    'developer-access-monitor',
    '*/5 * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_url')
                   || '/api/developer-monitor/jobs/sweep',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrttask_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );
  RAISE NOTICE '[dev-access monitor cron] scheduled developer-access-monitor (every 5 min).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[dev-access monitor cron] setup skipped: %', SQLERRM;
END$$;
