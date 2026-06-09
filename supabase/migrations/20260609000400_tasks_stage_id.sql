-- ============================================================
-- smrtPlan — task → stage (phase/banner within a project)
-- ============================================================
-- A project (plan) can have stages that act as banners grouping its tasks
-- ("Build AI tool" → "Voice tool" / "Video tool", each with its own tasks).
-- A task optionally belongs to one stage of its plan. ON DELETE SET NULL so
-- removing a stage just un-groups its tasks (they fall back to "no stage").
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS stage_id uuid REFERENCES smrtplan_stages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS tasks_stage_id_idx ON tasks(stage_id) WHERE stage_id IS NOT NULL;
