-- Cross-source duplicate detection.
--
-- When ai-process is fairly-but-not-certainly sure that a newly created task
-- is the same real-world event/obligation as an existing open task (different
-- source — e.g. a Gmail reminder vs. a Google Calendar appointment), it does
-- NOT auto-merge. Instead it stamps the new task with a pointer to the
-- suspected original so the UI can offer the user the existing merge flow.
--
-- HIGH-confidence matches are linked automatically (the new message is
-- appended as an update to the existing task) and never reach this column.
-- This column only ever holds MEDIUM-confidence suggestions awaiting the
-- user's decision.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS suggested_duplicate_of uuid
    REFERENCES tasks(id) ON DELETE SET NULL;

-- Partial index: only the handful of tasks currently carrying a pending
-- suggestion. Keeps the index tiny and makes the "tasks with a pending dup
-- suggestion" lookup cheap.
CREATE INDEX IF NOT EXISTS idx_tasks_suggested_duplicate_of
  ON tasks (suggested_duplicate_of)
  WHERE suggested_duplicate_of IS NOT NULL;

COMMENT ON COLUMN tasks.suggested_duplicate_of IS
  'Medium-confidence cross-source duplicate suggestion: points at the existing open task this one may duplicate. Set by ai-process. Cleared when the user merges or dismisses the suggestion.';
