-- Queued-behind-a-live-turn messages ("send while Claude is working", like Claude
-- Code). A 'waiting' run is a turn the user sent while another turn of the same
-- workspace group was still running: it sits in line and is promoted to 'queued'
-- (and executed) the moment the live turn finishes.
--
-- The status CHECK was created inline in 20260726120000, so it carries the
-- default constraint name <table>_<column>_check.

ALTER TABLE public.claude_runs
  DROP CONSTRAINT IF EXISTS claude_runs_status_check;

ALTER TABLE public.claude_runs
  ADD CONSTRAINT claude_runs_status_check
  CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed', 'canceled'));

-- The dispatcher looks up "the oldest waiting turn of a thread" after every
-- finished run; give that lookup an index so it stays cheap on a big table.
CREATE INDEX IF NOT EXISTS idx_claude_runs_waiting
  ON public.claude_runs (thread_id, turn_index)
  WHERE status = 'waiting';
