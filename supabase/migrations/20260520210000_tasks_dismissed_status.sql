-- Separate "dismissed" from "completed" in the tasks status enum.
--
-- Before this change, three different paths all set status='archived':
--   POST /tasks/:id/complete           (user finished the task)
--   POST /tasks/:id/dismiss-fast       (user dismissed a suggestion)
--   POST /tasks/:id/dismiss            (user dismissed with a reason)
--   POST /tasks/bulk-dismiss-fast      (batch dismiss)
-- which meant the Tasks page's "Completed" tab (filter status=archived)
-- showed dismissed suggestions alongside finished work.
--
-- The application code now writes status='dismissed' for every dismiss
-- path. This migration backfills the same separation for existing rows:
-- any row with status='archived' AND completed_at IS NULL was a
-- dismissal under the old scheme (real completions always stamp
-- completed_at). We promote it to 'dismissed'.

UPDATE tasks
   SET status = 'dismissed'
 WHERE status = 'archived'
   AND completed_at IS NULL;
