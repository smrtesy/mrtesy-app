-- ============================================================
-- smrtDesign — project interaction mode (v2)
-- ============================================================
-- 'conversation' (default): the project drives an interactive built-in Claude
--   thread — the user defines/refines the brief in chat and each render lands in
--   the gallery. A single ended turn is NOT a failure (the conversation continues).
-- 'auto': the v1 blind run — a form fires N options in one background run; the
--   driving run's terminal state flips the project to options_ready/failed.
-- Additive only (ADD COLUMN with a default) — safe to apply self-serve.

ALTER TABLE smrtdesign_projects
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'conversation'
  CHECK (mode IN ('conversation', 'auto'));

COMMENT ON COLUMN smrtdesign_projects.mode IS
  'conversation = interactive Claude thread (default); auto = v1 blind generation run';
