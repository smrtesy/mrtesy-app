-- ============================================================
-- smrtPlan — duration-weighted progress (fix #1)
-- ============================================================
-- Effort progress was a naive task count (2 of 4 = 50%), which weighs a 4-day
-- task the same as a 1-day one. Switch to a duration-weighted sum: each task's
-- weight is its duration_days (the value the engine already computes), so
-- completing the 4-day "characters" task counts more than a 1-day "lip-sync".
--   weighted = Σ duration(done) / Σ duration(all)
-- Streams keep the matrix cell ratio (cells have no duration).
-- The weight falls back to 1 for a task with no duration, so an un-estimated
-- effort plan still degrades gracefully to the old count-based behaviour.

CREATE OR REPLACE VIEW smrtplan_plan_progress
WITH (security_invoker = true) AS
SELECT
  p.id     AS plan_id,
  p.org_id AS org_id,
  p.kind   AS kind,
  CASE
    WHEN p.kind = 'stream' THEN COALESCE((
      SELECT count(*) FILTER (WHERE ess.status = 'done')::real
             / NULLIF(count(*), 0)::real
      FROM smrtplan_episode_stage_status ess
      JOIN smrtplan_episodes e ON e.id = ess.episode_id
      WHERE e.plan_id = p.id
    ), 0)
    ELSE COALESCE((
      SELECT sum(COALESCE(t.duration_days, 1)) FILTER (WHERE t.status IN ('completed', 'archived'))::real
             / NULLIF(sum(COALESCE(t.duration_days, 1)), 0)::real
      FROM tasks t
      WHERE t.plan_id = p.id
    ), 0)
  END AS computed_progress,
  COALESCE(
    p.progress_manual,
    CASE
      WHEN p.kind = 'stream' THEN COALESCE((
        SELECT count(*) FILTER (WHERE ess.status = 'done')::real
               / NULLIF(count(*), 0)::real
        FROM smrtplan_episode_stage_status ess
        JOIN smrtplan_episodes e ON e.id = ess.episode_id
        WHERE e.plan_id = p.id
      ), 0)
      ELSE COALESCE((
        SELECT sum(COALESCE(t.duration_days, 1)) FILTER (WHERE t.status IN ('completed', 'archived'))::real
               / NULLIF(sum(COALESCE(t.duration_days, 1)), 0)::real
        FROM tasks t
        WHERE t.plan_id = p.id
      ), 0)
    END
  ) AS effective_progress
FROM smrtplan_plans p;
