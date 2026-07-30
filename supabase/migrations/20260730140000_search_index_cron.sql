-- ============================================================
-- Global search — pg_cron schedule for the incremental index worker.
-- ============================================================
-- Mirrors the smrtreach cron (20260603150000): pg_cron hits a blocked Railway
-- route every minute (no node-cron on the backend). It POSTs to
-- /api/search/index/drain with the shared x-cron-secret; the endpoint drains a
-- bounded batch of search_index_queue — embedding each changed row and
-- upserting it into search_documents — so the search index stays fresh
-- automatically (≤ ~1 min lag) after the initial backfill.
--
-- Secret-free by design: the Railway base URL and the cron secret are read from
-- Supabase Vault at run time. Before this does anything, the operator must (once):
--
--   1. Enable the pg_cron and pg_net extensions (Dashboard → Database → Extensions).
--   2. Store the two values in Vault (Dashboard → Project Settings → Vault):
--        search_index_cron_url    = https://<your-railway-host>/api/search/index/drain
--        search_index_cron_secret = <same value as the server's CRON_SECRET / SMRTBOT_INTERNAL_SECRET>
--   3. Re-run this migration (or the DO block below) so the job gets scheduled.
--
-- Wrapped so it can NEVER fail the migration chain: a missing prerequisite just
-- RAISES NOTICE and returns.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE '[search index cron] pg_cron not installed — skipping. Enable it, set Vault secrets, then re-run.';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE '[search index cron] pg_net not installed — skipping. Enable it, set Vault secrets, then re-run.';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'search_index_cron_url')
     OR NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'search_index_cron_secret') THEN
    RAISE NOTICE '[search index cron] Vault secrets search_index_cron_url / search_index_cron_secret not set — skipping schedule.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('search-index-drain')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'search-index-drain');

  PERFORM cron.schedule(
    'search-index-drain',
    '* * * * *',
    $cron$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'search_index_cron_url'),
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'search_index_cron_secret')
        ),
        body    := '{}'::jsonb
      );
    $cron$
  );

  RAISE NOTICE '[search index cron] scheduled search-index-drain (every minute).';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[search index cron] setup skipped: %', SQLERRM;
END$$;
