-- claude_runs.ends_with_block — did this turn end on an unanswered interactive
-- question (smrt-ask / smrt-plan)?
--
-- WHY. The threads rail shows a blue "needs you" hourglass for a session whose newest
-- completed turn is waiting on the user's answer. Detecting that by pulling every
-- thread's result_summary (up to 20 KB each) on the rail's 5-second poll is a heavy,
-- repeated payload. Instead the runner computes this boolean ONCE at run completion
-- (runner.ts, ENDS_WITH_BLOCK_RE) and the rail reads the cheap flag off the newest run.
--
-- Additive: one nullable boolean column. The backfill populates it for existing runs
-- from result_summary using the same opening-fence pattern, so questions already
-- waiting light up immediately (it only writes the brand-new column — no existing
-- data is changed).

ALTER TABLE public.claude_runs
  ADD COLUMN IF NOT EXISTS ends_with_block boolean;

COMMENT ON COLUMN public.claude_runs.ends_with_block IS
  'True when this turn''s final assistant text ends on an interactive block (smrt-ask/plan). Drives the rail needs-you hourglass. Set by runner.ts.';

UPDATE public.claude_runs
   SET ends_with_block = (result_summary ~ '```[ \t]*smrt-(ask|plan)')
 WHERE ends_with_block IS NULL
   AND result_summary IS NOT NULL;
