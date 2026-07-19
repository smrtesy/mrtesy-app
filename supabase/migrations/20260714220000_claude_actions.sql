-- claude_actions — tracking for "work with Claude" launches (workclock day-tool
-- phase 5 / docs/workclock-plan.md §11). One row per Claude Code session the
-- user opens from smrtesy: the deep link + a best-effort status. Status is
-- advanced by the smrtesy browser extension (reads the claude.ai tab) and/or by
-- GitHub (the authoritative outcome — PR opened / merged), and can always be
-- set manually.
--
--   session_url  — the exact claude.ai/code session link (verbatim deep link).
--   status       — open → running → waiting (Claude needs you) → done | failed.
--   pr_url       — the resulting PR, when linked (GitHub is the real outcome).
--   task_id      — optional link to the smrtTask task this Claude run is for.

CREATE TABLE IF NOT EXISTS claude_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  task_id      uuid REFERENCES tasks(id) ON DELETE SET NULL,
  title        text,
  session_url  text,
  status       text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','running','waiting','done','failed')),
  pr_url       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claude_actions_user_status
  ON claude_actions (user_id, status, updated_at DESC);

ALTER TABLE claude_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS claude_actions_own_select ON claude_actions;
CREATE POLICY claude_actions_own_select ON claude_actions
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS claude_actions_own_insert ON claude_actions;
CREATE POLICY claude_actions_own_insert ON claude_actions
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS claude_actions_own_update ON claude_actions;
CREATE POLICY claude_actions_own_update ON claude_actions
  FOR UPDATE USING (user_id = auth.uid());

COMMENT ON TABLE claude_actions IS
  'Tracks Claude Code sessions launched from smrtesy: deep link + best-effort '
  'status (extension / GitHub / manual). See docs/workclock-plan.md §11.';
