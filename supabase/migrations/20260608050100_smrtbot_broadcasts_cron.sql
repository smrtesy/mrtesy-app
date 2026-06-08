-- ============================================================
-- smrtBot — pg_cron schedule for scheduled broadcasts (build plan model ג3)
-- ============================================================
-- Every minute, pg_cron POSTs to the Railway server's bounded job route, which
-- sends each due broadcast (smrtbot_scheduled_broadcasts) through the owning
-- bot's transport — Baileys for the unofficial channel, Meta for the official
-- one — and flips the row to sent/failed. Mirrors the smrtReach queue cron.
--
-- Secret-free by design: the Railway route URL and the shared secret are read
-- from Supabase Vault at run time — nothing sensitive is committed here. Before
-- this schedules anything, the operator must (once):
--
--   1. Enable the pg_cron + pg_net extensions (already enabled on Smrtesy).
--   2. Store the two values in Vault (Dashboard → Project Settings → Vault):
--        smrtbot_cron_url    = https://<your-railway-host>/api/bot/jobs/broadcasts
--        smrtbot_cron_secret = <the server's SMRTBOT_INTERNAL_SECRET (or CRON_SECRET) env>
--   3. Re-run this migration (or just the DO block) so the job gets scheduled.
--
-- Wrapped so it can NEVER fail the migration chain: a missing prerequisite just
-- RAISES NOTICE and returns.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[smrtbot cron] pg_cron not installed — skipping. Enable it, set Vault secrets, then re-run.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[smrtbot cron] pg_net not installed — skipping. Enable it, set Vault secrets, then re-run.';
    RETURN;
  END IF;

  -- Require both Vault secrets before scheduling.
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_secret') THEN
    RAISE NOTICE '[smrtbot cron] Vault secrets smrtbot_cron_url / smrtbot_cron_secret not set — skipping schedule.';
    RETURN;
  END IF;

  -- Replace any prior definition, then (re)schedule every minute.
  PERFORM cron.unschedule('smrtbot-broadcasts')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtbot-broadcasts');

  PERFORM cron.schedule(
    'smrtbot-broadcasts',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-smrtbot-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtbot_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );

  RAISE NOTICE '[smrtbot cron] scheduled smrtbot-broadcasts (every minute).';
EXCEPTION WHEN OTHERS THEN
  -- Never break the migration chain on a cron-infra hiccup.
  RAISE NOTICE '[smrtbot cron] setup skipped: %', SQLERRM;
END$$;
