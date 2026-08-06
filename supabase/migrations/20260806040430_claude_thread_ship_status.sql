-- Per-thread SHIP status — the rail's deploy dot.
--
-- WHY. A console session that ends "אני מנטר את הפריסה, אעדכן כשזה יעלה" never
-- actually monitors: the turn-based runner stops when the turn ends, so nothing
-- polls the deploy and nothing reports back. This gives every thread a persistent,
-- code-maintained SHIP outcome that a background watcher (ship-status.ts) keeps
-- fresh AFTER the turn ends — surfaced as one coloured dot in the threads rail:
--   NULL            → grey   (ended without pushing anything)
--   'pushed_branch' → yellow (pushed a branch / queued for merge, not on main)
--   'main_building' → yellow (pushed to main, the deploy build is still running)
--   'main_live'     → green  (on main AND the production deploy is confirmed live)
--   'failed'        → red    (pushed to main but the build FAILED)
--
-- Additive only (new nullable columns + a partial index the watcher scans on), so
-- it is safe to apply without touching any existing row.

ALTER TABLE public.claude_threads
  ADD COLUMN IF NOT EXISTS ship_state      text,
  ADD COLUMN IF NOT EXISTS ship_ref        text,
  ADD COLUMN IF NOT EXISTS ship_sha        text,
  ADD COLUMN IF NOT EXISTS ship_surface    text,
  ADD COLUMN IF NOT EXISTS ship_branch     text,
  ADD COLUMN IF NOT EXISTS ship_detail     text,
  ADD COLUMN IF NOT EXISTS ship_updated_at timestamptz;

COMMENT ON COLUMN public.claude_threads.ship_state IS
  'Rail deploy dot: NULL=no push, pushed_branch, main_building, main_live, failed. Maintained by ship-status.ts.';

-- The watcher polls only threads still confirming a main deploy — a tiny, hot set.
CREATE INDEX IF NOT EXISTS idx_claude_threads_ship_building
  ON public.claude_threads (ship_updated_at)
  WHERE ship_state = 'main_building';
