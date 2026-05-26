-- ============================================================
-- smrtVoice — Add tables to realtime publication
-- ============================================================
-- The frontend subscribes to postgres_changes on smrtvoice_projects
-- (project progress), smrtvoice_lines (per-line completion), and
-- smrtvoice_jobs (overall job status). The publication has to include
-- each table explicitly.

-- Idempotent guard: ADD TABLE errors if already added, so we check first.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='smrtvoice_projects'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE smrtvoice_projects';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='smrtvoice_lines'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE smrtvoice_lines';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND schemaname='public' AND tablename='smrtvoice_jobs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE smrtvoice_jobs';
  END IF;
END$$;
