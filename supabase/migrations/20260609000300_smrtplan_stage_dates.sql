-- ============================================================
-- smrtPlan — stage timeline window (squares per stage on the board)
-- ============================================================
-- A stage can carry its own [start_date, end_date] so each plan row renders one
-- draggable square per stage along the timeline (instead of a single bar). When
-- a stage has no explicit window the board derives one by tiling the stages in
-- sequence across the plan span (using default_duration_days), and persists an
-- explicit window the moment the square is dragged.
--
-- Additive + nullable: existing stages (stream matrix columns) are unaffected.
ALTER TABLE smrtplan_stages
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date   date;
