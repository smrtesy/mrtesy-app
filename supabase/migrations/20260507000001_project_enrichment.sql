-- Migration: Project enrichment for AI matching + brief fact verification
-- Safe to run multiple times (IF NOT EXISTS / OR REPLACE guards).

-- ============================================================
-- 1. EXTEND projects TABLE
--    keywords  — list of terms that appear in messages about this project
--    key_contacts — emails / names / phones associated with the project
-- ============================================================

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS keywords     text[]    DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS key_contacts text[]    DEFAULT '{}';

-- ============================================================
-- 2. EXTEND project_briefs TABLE
--    pending_facts   — AI-extracted facts awaiting user verification
--    verified_facts  — facts the user has approved
--    rejected_facts  — facts the user rejected (so AI doesn't re-suggest)
-- ============================================================

ALTER TABLE project_briefs
  ADD COLUMN IF NOT EXISTS pending_facts  jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS verified_facts jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS rejected_facts jsonb DEFAULT '[]';

-- ============================================================
-- 3. EXTEND tasks TABLE
--    project_confidence — how confident AI was when linking to project
-- ============================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS project_confidence numeric(4,3);

-- ============================================================
-- 4. INDEX — fast lookup of pending tasks per project
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_tasks_project_id
  ON tasks (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_verified
  ON tasks (user_id, manually_verified, status);
