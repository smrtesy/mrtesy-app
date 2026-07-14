-- Mandatory completion debrief for research tasks (docs/project-planning-protocol
-- §5 "שלב ו — יומן ניסויים ופלייבוק"; the enforcement lives in the app, this is the
-- store). Two additive pieces:
--
--   tasks.requires_debrief — a research task (spike/funnel/bake-off) cannot be
--                            marked complete until a valid debrief is filed. Set
--                            by the plan-builder / import (mirrors is_decision).
--   task_debriefs          — the structured debrief itself. One valid row is what
--                            unlocks completion; its answers also feed the playbook.
--
-- Both are additive and defaulted/nullable, so existing tasks are unaffected.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS requires_debrief boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN tasks.requires_debrief IS
  'Research task: completion is blocked (422) at every done-path until a task_debriefs row exists (planning protocol §5 "שלב ו").';

CREATE TABLE IF NOT EXISTS task_debriefs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Where the experiment ran. 'no_experiment' requires a stated reason (enforced
  -- in the app, alongside the conditional required fields per branch).
  conducted_in text NOT NULL CHECK (conducted_in IN ('claude', 'external', 'both', 'no_experiment')),
  answers      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_debriefs_task ON task_debriefs (task_id);
CREATE INDEX IF NOT EXISTS idx_task_debriefs_org_created ON task_debriefs (org_id, created_at DESC);

ALTER TABLE task_debriefs ENABLE ROW LEVEL SECURITY;

-- Personal own-row policies, exactly like focus_sessions: each row belongs to the
-- user who filed it; they see/write only their own. The backend (service role,
-- bypasses RLS) sets org_id and is the only reader for the manager pulse view, so
-- own-row policies are sufficient and no cross-user client read is exposed.
DROP POLICY IF EXISTS task_debriefs_own_select ON task_debriefs;
CREATE POLICY task_debriefs_own_select ON task_debriefs
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS task_debriefs_own_insert ON task_debriefs;
CREATE POLICY task_debriefs_own_insert ON task_debriefs
  FOR INSERT WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE task_debriefs IS
  'Structured completion debrief for a research task. One valid row unlocks the '
  'task''s completion; the answers feed the playbook (planning protocol §5 "שלב ו").';
