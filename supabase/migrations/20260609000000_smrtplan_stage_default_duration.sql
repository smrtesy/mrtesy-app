-- ============================================================
-- smrtPlan — stage default duration (stream duration inheritance)
-- ============================================================
-- A stream stage carries a DEFAULT working-day duration. A cell-task (one
-- matrix cell, episode × stage) that has no hand-pinned duration inherits its
-- stage's default — so "edit = 5 days, translate = 3 days" is set once on the
-- stage and every episode's cell uses it, with sparse per-cell overrides.
--
-- numeric (not int) so half-days land cleanly when tasks.duration_days becomes
-- numeric in a later slice. Nullable: existing stages simply have no default
-- (those cells fall back to estimate/none, exactly as before).
ALTER TABLE smrtplan_stages
  ADD COLUMN IF NOT EXISTS default_duration_days numeric;
