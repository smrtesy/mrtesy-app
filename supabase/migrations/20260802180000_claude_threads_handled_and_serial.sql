-- Claude console thread rail: two additive columns.
--
-- handled_at — a manual "I'm done with this session" mark the user sets from the
--   thread rail (a faint checkmark that turns green). A handled thread dims and
--   sorts to the bottom of the rail, so the top stays the live/unhandled work.
--   Nullable timestamp: null = not handled, a timestamp = when it was marked.
--
-- task_serial — the smrtTask serial (e.g. "T1699") of the task a thread was
--   opened for, when it was opened by the corrections/autofix flow. Lets the rail
--   lead the title with the ID and lets the auto-titler keep that ID (and never
--   prepend "תיקון אוטומטי"). Null for ordinary chat threads that aren't tied to
--   a task.
--
-- Both additive and nullable — no existing row or flow is affected.

ALTER TABLE public.claude_threads
  ADD COLUMN IF NOT EXISTS handled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS task_serial text;

COMMENT ON COLUMN public.claude_threads.handled_at IS
  'When the user manually marked this thread handled from the rail (green check). '
  'Null = not handled. A handled thread dims and sorts to the bottom of the rail.';
COMMENT ON COLUMN public.claude_threads.task_serial IS
  'smrtTask serial (e.g. T1699) of the task this thread was opened for by the '
  'corrections/autofix flow; null for ordinary chat threads. The rail leads the '
  'title with it and the auto-titler preserves it.';
