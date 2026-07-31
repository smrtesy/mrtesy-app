-- smrtStudio — actually schedule the weekly catalog sweep.
--
-- The sweep cron was authored in 20260728051500_smrtstudio_catalog_weekly_sweep.sql,
-- but that migration only schedules the job when the two Vault secrets
-- (smrtstudio_cron_url / smrtstudio_cron_secret) already exist AT MIGRATION RUN
-- TIME. When 20260728051500 ran, those secrets were not set yet, so it took the
-- documented "secrets not set — skipping schedule" branch and no-op'd. The
-- secrets were provisioned afterwards, but a migration does not re-run itself,
-- so `smrtstudio-catalog-sweep` never appeared in cron.job — and the catalog
-- kept refreshing only when a human pressed "Run sweep" on /studio/models.
--
-- This migration re-applies the exact same guarded scheduling now that the
-- secrets exist. It is idempotent (unschedule-then-schedule) and re-running is
-- safe. Additive / reversible: it adds a pg_cron entry, drops/rewrites no data.
--
-- The sweep is FREE — it reads fal's catalog and OpenAPI schema endpoints and
-- never an inference endpoint — so scheduling it costs nothing. The "Run sweep"
-- button stays as a manual "refresh now".

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[smrtstudio cron] pg_cron not installed — skipping.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[smrtstudio cron] pg_net not installed — skipping.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_secret') THEN
    RAISE NOTICE '[smrtstudio cron] Vault secrets smrtstudio_cron_url / smrtstudio_cron_secret not set — skipping schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('smrtstudio-catalog-sweep')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtstudio-catalog-sweep');

  -- Mondays 07:00 UTC — the small hours in New York, where the operator is.
  PERFORM cron.schedule(
    'smrtstudio-catalog-sweep',
    '0 7 * * 1',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtstudio_cron_secret')
        ),
        body    := '{"probe_limit": 150}'::jsonb,
        timeout_milliseconds := 600000
      );
    $cron$
  );

  RAISE NOTICE '[smrtstudio cron] scheduled smrtstudio-catalog-sweep (Mondays 07:00 UTC).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[smrtstudio cron] setup skipped: %', SQLERRM;
END$$;
