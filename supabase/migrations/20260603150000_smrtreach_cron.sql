-- ============================================================
-- smrtReach — pg_cron schedule for the email queue processor (build plan §H)
-- ============================================================
-- Model ג3: pg_cron hits a blocked Railway route (no node-cron). Every minute
-- it POSTs to /api/reach/cron/process-queue with the shared x-cron-secret,
-- which drains a bounded batch of the pending email queue across all orgs.
--
-- Secret-free by design: the Railway base URL and the cron secret are read from
-- Supabase Vault at run time — nothing sensitive is committed here. Before this
-- does anything, the operator must (once):
--
--   1. Enable the pg_cron and pg_net extensions (Dashboard → Database → Extensions).
--   2. Store the two values in Vault (Dashboard → Project Settings → Vault):
--        smrtreach_cron_url    = https://<your-railway-host>/api/reach/cron/process-queue
--        smrtreach_cron_secret = <the same value as the server's CRON_SECRET env>
--   3. Re-run this migration (or the DO block below) so the job gets scheduled.
--
-- The whole thing is wrapped so it can NEVER fail the migration chain: if a
-- prerequisite is missing it just RAISES NOTICE and returns.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[smrtreach cron] pg_cron not installed — skipping. Enable it, set Vault secrets, then re-run.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[smrtreach cron] pg_net not installed — skipping. Enable it, set Vault secrets, then re-run.';
    RETURN;
  END IF;

  -- Require both Vault secrets before scheduling.
  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtreach_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'smrtreach_cron_secret') THEN
    RAISE NOTICE '[smrtreach cron] Vault secrets smrtreach_cron_url / smrtreach_cron_secret not set — skipping schedule.';
    RETURN;
  END IF;

  -- Replace any prior definition, then (re)schedule every minute.
  PERFORM cron.unschedule('smrtreach-process-queue')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'smrtreach-process-queue');

  PERFORM cron.schedule(
    'smrtreach-process-queue',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtreach_cron_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'smrtreach_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );

  RAISE NOTICE '[smrtreach cron] scheduled smrtreach-process-queue (every minute).';
EXCEPTION WHEN OTHERS THEN
  -- Never break the migration chain on a cron-infra hiccup.
  RAISE NOTICE '[smrtreach cron] setup skipped: %', SQLERRM;
END$$;
