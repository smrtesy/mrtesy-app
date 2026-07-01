-- smrtVoice v2: publish smrtvoice_scripts for realtime.
--
-- The script page subscribes to UPDATEs on smrtvoice_scripts to live-refresh
-- status and progress counters. v1 published projects/lines/jobs; scripts is
-- new in v2 and must be added too. Idempotent guard (ADD TABLE errors if the
-- table is already a publication member).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'smrtvoice_scripts'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE smrtvoice_scripts';
  END IF;
END $$;
