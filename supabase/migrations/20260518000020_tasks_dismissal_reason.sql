-- Track WHY the user dismissed a task. The code is one of a small enum
-- (see DISMISSAL_CODES in server/src/modules/smrttask/tasks/routes.ts);
-- reason_text is free-form, required only when code='custom'.
-- For codes that indicate "the sender shouldn't bother me again"
-- (sender_unimportant, spam) the dismiss endpoint also writes a
-- rules_memory entry so future syncs filter the sender out.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS dismissal_reason_code text,
  ADD COLUMN IF NOT EXISTS dismissal_reason_text text;

CREATE INDEX IF NOT EXISTS tasks_dismissal_reason_code_idx
  ON tasks(dismissal_reason_code) WHERE dismissal_reason_code IS NOT NULL;
