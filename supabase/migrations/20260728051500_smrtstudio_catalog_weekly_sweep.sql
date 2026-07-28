-- smrtStudio — refresh the fal catalog on a schedule instead of on a button.
--
-- fal publishes models continuously. Until now the catalog only learned about
-- them when a person happened to press "Run sweep", so the shelf was exactly as
-- fresh as the last time someone remembered — and after the sweep grew from
-- ~513 endpoints to all ~1394, finishing it took about seven presses. That is
-- not an interface, it is a chore.
--
-- The sweep is FREE: it reads fal's catalog and OpenAPI schema endpoints and
-- never an inference endpoint, so no run is ever billed no matter how often
-- this fires. Weekly is chosen to match how fast fal's catalog actually moves;
-- the button stays for "refresh now".
--
-- Follows the smrtBot broadcast-cron pattern exactly: Vault-held URL and
-- secret, hard guards on every precondition, unschedule-then-schedule so
-- re-running is safe, and an exception handler so a cron-infra hiccup can
-- never break the migration chain.
--
-- One-time setup before this can fire (until then it is a documented no-op):
--   select vault.create_secret('https://<backend-host>/api/studio/jobs/sweep',
--                              'smrtstudio_cron_url');
--   select vault.create_secret('<CRON_SECRET or SMRTSTUDIO_INTERNAL_SECRET>',
--                              'smrtstudio_cron_secret');
-- The secret must equal the backend's SMRTSTUDIO_INTERNAL_SECRET (or its
-- CRON_SECRET fallback); the route rejects the call otherwise, and rejects it
-- outright when no secret is configured at all.

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
