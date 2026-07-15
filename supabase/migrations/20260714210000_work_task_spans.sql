-- work_task_spans — per-task time spans within a work session (workclock
-- day-tool, phase 4 / docs/workclock-plan.md §7.2). Feeds the "learning" view:
-- average time per size, per task, and trends. One row per closed active-task
-- span; the live span is only persisted here when it closes (task switch /
-- clear / stop).
--
-- Kept deliberately lightweight — the aggregate per-size totals already live on
-- work_sessions; this table is the granular breakdown for insights.

CREATE TABLE IF NOT EXISTS work_task_spans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_date   date NOT NULL,
  -- The task the span was spent on. Nullable + ON DELETE SET NULL so deleting a
  -- task never drops its historical time (still counts toward totals by size).
  task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  size        text NOT NULL CHECK (size IN ('quick','medium','big')),
  seconds     integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_task_spans_user_date
  ON work_task_spans (user_id, work_date DESC);

ALTER TABLE work_task_spans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS work_task_spans_own_select ON work_task_spans;
CREATE POLICY work_task_spans_own_select ON work_task_spans
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS work_task_spans_own_insert ON work_task_spans;
CREATE POLICY work_task_spans_own_insert ON work_task_spans
  FOR INSERT WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE work_task_spans IS
  'Per-task time spans within a workclock session — the granular basis for the '
  'learning/insights view. See docs/workclock-plan.md §7.2.';
