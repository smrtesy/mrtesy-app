-- ============================================================
-- smrtPlan — new plan kind 'roster' (ריכוז)
-- ============================================================
-- A "roster" plan is a person/domain row that AGGREGATES tasks by assignee
-- (its owner_user_id) instead of CONTAINING them (plan_id). e.g. "עיצוב"
-- becomes a roster that surfaces every task assigned to the design person,
-- wherever those tasks actually live (video tool, campaign, …).

ALTER TABLE smrtplan_plans DROP CONSTRAINT IF EXISTS smrtplan_plans_kind_check;
ALTER TABLE smrtplan_plans
  ADD CONSTRAINT smrtplan_plans_kind_check CHECK (kind IN ('effort', 'stream', 'roster'));

-- Progress view: roster progress = duration-weighted completion of the owner's
-- tasks across all plans. (effort = by plan_id; stream = matrix cells.)
CREATE OR REPLACE VIEW smrtplan_plan_progress
WITH (security_invoker = true) AS
WITH calc AS (
  SELECT
    p.id AS plan_id,
    p.org_id,
    p.kind,
    CASE
      WHEN p.kind = 'stream' THEN COALESCE((
        SELECT count(*) FILTER (WHERE ess.status = 'done')::real / NULLIF(count(*), 0)::real
        FROM smrtplan_episode_stage_status ess
        JOIN smrtplan_episodes e ON e.id = ess.episode_id
        WHERE e.plan_id = p.id
      ), 0)
      WHEN p.kind = 'roster' THEN COALESCE((
        SELECT sum(COALESCE(t.duration_days, 1)) FILTER (WHERE t.status IN ('completed', 'archived'))::real
               / NULLIF(sum(COALESCE(t.duration_days, 1)), 0)::real
        FROM tasks t
        WHERE t.plan_id IS NOT NULL AND p.owner_user_id IS NOT NULL
          AND t.assigned_to_user_id = p.owner_user_id
      ), 0)
      ELSE COALESCE((
        SELECT sum(COALESCE(t.duration_days, 1)) FILTER (WHERE t.status IN ('completed', 'archived'))::real
               / NULLIF(sum(COALESCE(t.duration_days, 1)), 0)::real
        FROM tasks t
        WHERE t.plan_id = p.id
      ), 0)
    END AS computed_progress,
    p.progress_manual
  FROM smrtplan_plans p
)
SELECT
  plan_id,
  org_id,
  kind,
  computed_progress,
  COALESCE(progress_manual, computed_progress) AS effective_progress
FROM calc;
