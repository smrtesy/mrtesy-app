-- Reduce Supabase Disk-IO pressure (incident 2026-07-30).
-- Root cause: the instance exhausted its Disk IO budget → getUser() in
-- src/middleware.ts timed out → 504 MIDDLEWARE_INVOCATION_TIMEOUT sitewide.
-- See docs/supabase-io-incident-2026-07-30.md for the full analysis.
--
-- All three changes below are zero-functional-impact and reversible. They were
-- applied to production on 2026-07-30 (indexes built CONCURRENTLY, outside a
-- txn); this file is the forward-only record and is idempotent on re-run.

-- (A) Partial index for the batch-details "needs body extraction" poll
--     (source_type + body_text IS NULL, no user_id) — was doing full seq-scans
--     every 3 min. Pure planner win; the partial predicate keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_source_messages_needs_body
  ON public.source_messages (source_type, created_at)
  WHERE body_text IS NULL;

-- (A2) Partial index for the project-detection poll (user_id + needs_project_check).
CREATE INDEX IF NOT EXISTS idx_source_messages_needs_project
  ON public.source_messages (user_id)
  WHERE needs_project_check = true;

-- (B) Drop three smrtVoice tables from the Realtime publication. No client
--     subscribes to them (audited across src/), so removing them cuts WAL-decode
--     IO with no user-visible effect. Guarded so re-running is a no-op.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['smrtvoice_jobs','smrtvoice_projects','smrtvoice_line_takes']
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- (C) NOTE: net._http_response (pg_net) had bloated to 58MB with 0 live rows.
--     It was reclaimed manually on 2026-07-30 via `VACUUM (FULL, ANALYZE)
--     net._http_response;` (58MB → 600kB). VACUUM cannot run inside a migration
--     transaction, so it is intentionally NOT included here — documented only.
