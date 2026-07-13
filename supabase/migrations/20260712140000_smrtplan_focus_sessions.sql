-- Plan-focus day-tool infrastructure (docs/smrtplan-focus-integration.md §2,
-- docs/day-tools-plan.md §8.5). Two personal, org-scoped tables that sit as an
-- execution layer OVER smrtPlan — they do NOT touch the scheduling engine.
--
--   smrtplan_focus  — a per-person daily-time commitment to a plan. A team
--                     member commits their own daily minutes to the same plan,
--                     so it is keyed (plan_id, user_id). active=true → the plan
--                     shows up every day as a focus block on /tasks.
--   focus_sessions  — the log of each daily focus run (planned vs actual
--                     minutes, stages completed) — feeds streaks + history.

CREATE TABLE IF NOT EXISTS smrtplan_focus (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id       uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  daily_minutes integer NOT NULL CHECK (daily_minutes > 0),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_smrtplan_focus_user_active
  ON smrtplan_focus (user_id) WHERE active;

CREATE TABLE IF NOT EXISTS focus_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id         uuid NOT NULL REFERENCES smrtplan_plans(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_date    date NOT NULL,
  planned_minutes integer NOT NULL CHECK (planned_minutes >= 0),
  actual_minutes  integer NOT NULL DEFAULT 0 CHECK (actual_minutes >= 0),
  tasks_completed integer NOT NULL DEFAULT 0 CHECK (tasks_completed >= 0),
  completed_full  boolean NOT NULL DEFAULT false,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_focus_sessions_user_date
  ON focus_sessions (user_id, session_date DESC);

ALTER TABLE smrtplan_focus ENABLE ROW LEVEL SECURITY;
ALTER TABLE focus_sessions ENABLE ROW LEVEL SECURITY;

-- Personal: each row belongs to one user; they see and write only their own.
-- The backend (service role, bypasses RLS) sets org_id from the active org, so
-- own-row policies are sufficient — mirrors marathon_runs / daily_plans.
DROP POLICY IF EXISTS smrtplan_focus_own_select ON smrtplan_focus;
CREATE POLICY smrtplan_focus_own_select ON smrtplan_focus
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS smrtplan_focus_own_insert ON smrtplan_focus;
CREATE POLICY smrtplan_focus_own_insert ON smrtplan_focus
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS smrtplan_focus_own_update ON smrtplan_focus;
CREATE POLICY smrtplan_focus_own_update ON smrtplan_focus
  FOR UPDATE USING (user_id = auth.uid());
DROP POLICY IF EXISTS smrtplan_focus_own_delete ON smrtplan_focus;
CREATE POLICY smrtplan_focus_own_delete ON smrtplan_focus
  FOR DELETE USING (user_id = auth.uid());

DROP POLICY IF EXISTS focus_sessions_own_select ON focus_sessions;
CREATE POLICY focus_sessions_own_select ON focus_sessions
  FOR SELECT USING (user_id = auth.uid());
DROP POLICY IF EXISTS focus_sessions_own_insert ON focus_sessions;
CREATE POLICY focus_sessions_own_insert ON focus_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS focus_sessions_own_update ON focus_sessions;
CREATE POLICY focus_sessions_own_update ON focus_sessions
  FOR UPDATE USING (user_id = auth.uid());

COMMENT ON TABLE smrtplan_focus IS
  'Per-person daily-time commitment to a smrtPlan plan (execution layer, not the '
  'engine). active → the plan appears as a daily focus block on /tasks. '
  'See docs/smrtplan-focus-integration.md §2.';
COMMENT ON TABLE focus_sessions IS
  'Log of each daily focus run (planned/actual minutes, stages completed). '
  'See docs/smrtplan-focus-integration.md §2.';
