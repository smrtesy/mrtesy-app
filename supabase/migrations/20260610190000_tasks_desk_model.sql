-- Desk model foundations (docs/tasks-unification-spec.md).
--
-- Adds the fields the unified tasks page needs:
--   tasks.size                — quick|regular, drives the two desk columns and
--                               the quick-marathon mode. AI proposes it at
--                               suggestion time; default 'regular' keeps the
--                               quick list trustworthy when unsure.
--   tasks.context             — home|work, dedicated field (not a tag) for the
--                               "where can I do this" filter. Manual-only for
--                               now (no AI guessing).
--   tasks.woke_from_snooze_at — set by the snooze-wake path when a row flips
--                               back from 'snoozed'; the UI shows a "returned
--                               from snooze" chip until first interaction
--                               clears it.
--   smrtplan_plans.manager_user_id — per-plan manager (the board square, not
--                               per task). Gets notified when a task in their
--                               plan is within 3 working days of its effective
--                               deadline and still blocked.
--   marathon_runs             — one row per quick-task marathon; records and
--                               history are derived from it.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS size text NOT NULL DEFAULT 'regular'
    CHECK (size IN ('quick', 'regular'));

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS context text
    CHECK (context IN ('home', 'work'));

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS woke_from_snooze_at timestamptz;

ALTER TABLE smrtplan_plans
  ADD COLUMN IF NOT EXISTS manager_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS marathon_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
  skipped_count   integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_marathon_runs_user_time
  ON marathon_runs(user_id, started_at DESC);

ALTER TABLE marathon_runs ENABLE ROW LEVEL SECURITY;

-- Runs are personal: a user sees and writes only their own rows. Service role
-- bypasses RLS as usual.
DROP POLICY IF EXISTS marathon_runs_own_select ON marathon_runs;
CREATE POLICY marathon_runs_own_select ON marathon_runs
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS marathon_runs_own_insert ON marathon_runs;
CREATE POLICY marathon_runs_own_insert ON marathon_runs
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS marathon_runs_own_update ON marathon_runs;
CREATE POLICY marathon_runs_own_update ON marathon_runs
  FOR UPDATE USING (user_id = auth.uid());

COMMENT ON COLUMN tasks.size IS
  'quick|regular — desk column + marathon eligibility. AI-proposed, user-correctable.';
COMMENT ON COLUMN tasks.context IS
  'home|work — dedicated execution-context filter. Manual-only.';
COMMENT ON COLUMN tasks.woke_from_snooze_at IS
  'Set when the row wakes from snooze; cleared on first user interaction (drives the chip).';
COMMENT ON COLUMN smrtplan_plans.manager_user_id IS
  'Per-plan manager; notified about blocked tasks near their effective deadline.';
COMMENT ON TABLE marathon_runs IS
  'Quick-task marathon sessions; records/history derived. See docs/tasks-unification-spec.md §6.';
