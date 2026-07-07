-- smrtTask: "waiting on Claude" flag on a task.
--
-- When the user hands a task off to Claude (opens claude.ai/code from the task
-- detail), we mark the task so they can move on to other work and see at a
-- glance which tasks are still pending Claude. Completion is signalled by
-- claude.ai's own browser notifications; clearing the flag here is manual
-- (the user marks "Claude finished" on the task).
--
-- Nullable timestamp: null = not waiting; a value = waiting since that instant
-- (drives the row chip + its tooltip). One column carries both the boolean
-- state and the "since when", mirroring woke_from_snooze_at.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS claude_waiting_since timestamptz;
