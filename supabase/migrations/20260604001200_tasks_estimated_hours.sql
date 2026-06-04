-- ============================================================
-- smrtPlan — task effort estimate + manual-duration flag
-- ============================================================
-- estimated_hours: the task's effort in hours (set directly or copied from the
--   smrtplan_estimates catalog). The engine derives working-days from it via the
--   assignee's capacity (hours/day), falling back to the org default (8h).
-- duration_manual: true when a human pinned duration_days by hand — the engine
--   then leaves it alone ("human overrides"). When false, the engine owns
--   duration_days (computed from hours/capacity, equal-split, or the default).
--
-- Backfill: existing plan tasks already carry a deliberate duration_days (the
-- Maor seed), so flag them manual=true to preserve those values on the first
-- post-deploy engine run.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS estimated_hours numeric,
  ADD COLUMN IF NOT EXISTS duration_manual boolean NOT NULL DEFAULT false;

UPDATE tasks
   SET duration_manual = true
 WHERE plan_id IS NOT NULL
   AND duration_days IS NOT NULL
   AND duration_manual = false;
