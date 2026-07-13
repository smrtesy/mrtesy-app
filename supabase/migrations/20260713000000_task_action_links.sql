-- Action nuggets: AI-extracted deep-link buttons on a task.
--
-- Instead of pasting a payment / tracking / invoice / meeting-join URL into the
-- task description (forcing the user to open the source email and hunt for the
-- link), the task builder now emits these links as structured "nuggets" — small
-- labeled buttons that take the user straight to the destination in one click.
-- Rendered on the task card, the open-task detail sheet, and the run view.
--
-- Shape per item:
--   { label: string,   -- 2-4 Hebrew words naming the destination ("מעקב ותשלום")
--     url:   string }   -- the EXACT deep URL, verbatim (query params/fragments kept)
--
-- Same read-only-from-client contract as ai_actions: written by ai-process,
-- never in the PATCH whitelist. Default [] so every existing task is well-formed.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS action_links jsonb NOT NULL DEFAULT '[]'::jsonb;
