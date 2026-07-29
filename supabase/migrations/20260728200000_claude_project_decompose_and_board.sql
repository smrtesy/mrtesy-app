-- Claude chat: forward decomposition into a project tree, + a shared project board.
--
-- The distinction from the existing split (20260728120000):
--   split      — REACTIVE. A chat wandered into several topics; move existing turns
--                out into children after the fact.
--   decompose  — DELIBERATE. A "general plan" chat is broken FORWARD into parts
--                (design, content…). Each part becomes a NEW child that starts with a
--                briefing (seed_context) — the plan chat keeps all its turns.
--
-- Both create children via parent_thread_id (already added in 20260728120000). What
-- this migration adds:
--   1. 'decompose' as a third analysis kind.
--   2. A project BOARD — one shared markdown note per project, living on the project
--      ROOT (the top-most ancestor). Children read it ON DEMAND (never automatically),
--      so the board is the "shared memory" without inflating every turn's context.
--
-- All additive, backend-only (service-role Express), RLS already on the tables.

-- ── decompose as an analysis kind ──────────────────────────────────────────────
-- The kind CHECK was created inline and unnamed in 20260728120000, so it carries the
-- conventional auto name. Drop-if-exists then re-add keeps this migration replayable.
ALTER TABLE claude_thread_analyses
  DROP CONSTRAINT IF EXISTS claude_thread_analyses_kind_check;
ALTER TABLE claude_thread_analyses
  ADD CONSTRAINT claude_thread_analyses_kind_check
  CHECK (kind IN ('split', 'group', 'title', 'decompose'));


-- ── the shared project board ────────────────────────────────────────────────────
-- Markdown, meaningful on the project ROOT row. A child resolves the board by walking
-- parent_thread_id up to the top ancestor and reading ITS board — so every chat in the
-- project sees one board, and there is no separate table to keep in sync.
--
-- Why on the thread and not a new table: the "project" has no identity of its own — it
-- IS the root chat (the general plan). Storing the board on that row means deleting the
-- project is deleting the chat, with nothing orphaned.
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS project_board text;
ALTER TABLE claude_threads
  ADD COLUMN IF NOT EXISTS project_board_updated_at timestamptz;

COMMENT ON COLUMN claude_threads.project_board IS
  'Shared project board (markdown), meaningful on the project root thread. Children '
  'read it on demand by resolving to the top ancestor. NULL = no board yet.';
