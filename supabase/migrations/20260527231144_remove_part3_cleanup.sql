-- Remove Part3 (classifier) artifacts now that classification runs via
-- the ai-process edge function on pg_cron.
--
-- What changes:
--   1. Close the one run_session stuck in 'running' (part3, since 2026-05-26).
--   2. Delete the orphaned sync_schedules row for part3 (is_enabled=false).
--   3. Tighten sync_schedules_part_check — remove part2 (WhatsApp, event-driven)
--      and part3 (classifier, moved to edge function). Keep part1 and part4.
--
-- What does NOT change:
--   run_sessions_part_check — left as-is because 140 historical rows with
--   part='part3' exist; dropping those values from the constraint would
--   require deleting historical data.

-- 1. Close the stuck part3 run_session
UPDATE run_sessions
SET status   = 'failed',
    ended_at = now(),
    summary  = 'Closed by cleanup — Part3 removed from codebase'
WHERE status = 'running'
  AND part   = 'part3';

-- 2. Delete the orphaned sync_schedule row for part3
DELETE FROM sync_schedules
WHERE part = 'part3';

-- 3. Tighten sync_schedules CHECK — no part2/part3 entries exist after step 2
ALTER TABLE sync_schedules
  DROP CONSTRAINT sync_schedules_part_check;

ALTER TABLE sync_schedules
  ADD CONSTRAINT sync_schedules_part_check
  CHECK (part IN ('part1', 'part4'));
