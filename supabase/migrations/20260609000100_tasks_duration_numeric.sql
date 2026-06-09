-- ============================================================
-- smrtPlan — task duration as numeric (half-day support)
-- ============================================================
-- A task's working-day duration can now be fractional (e.g. 0.5 = half a day),
-- so light tasks count partially toward a person's load instead of rounding up
-- to a whole day. Widening int → numeric is lossless and backward compatible.
--
-- The duration-weighted progress view depends on tasks.duration_days, so it is
-- dropped and recreated (verbatim, security_invoker) around the type change —
-- Postgres won't alter a column a view reads.
DROP VIEW IF EXISTS smrtplan_plan_progress;

ALTER TABLE tasks
  ALTER COLUMN duration_days TYPE numeric USING duration_days::numeric;

CREATE VIEW smrtplan_plan_progress
WITH (security_invoker = true) AS
WITH calc AS (
  SELECT p.id AS plan_id,
         p.org_id,
         p.kind,
         CASE
           WHEN p.kind = 'stream' THEN COALESCE((
             SELECT count(*) FILTER (WHERE ess.status = 'done')::real / NULLIF(count(*), 0)::real
             FROM smrtplan_episode_stage_status ess
             JOIN smrtplan_episodes e ON e.id = ess.episode_id
             WHERE e.plan_id = p.id), 0::real)
           WHEN p.kind = 'roster' THEN COALESCE((
             SELECT sum(COALESCE(t.duration_days, 1)) FILTER (WHERE t.status = ANY (ARRAY['completed', 'archived']))::real
                    / NULLIF(sum(COALESCE(t.duration_days, 1)), 0)::real
             FROM tasks t
             WHERE t.plan_id IS NOT NULL AND p.owner_user_id IS NOT NULL AND t.assigned_to_user_id = p.owner_user_id), 0::real)
           ELSE COALESCE((
             SELECT sum(COALESCE(t.duration_days, 1)) FILTER (WHERE t.status = ANY (ARRAY['completed', 'archived']))::real
                    / NULLIF(sum(COALESCE(t.duration_days, 1)), 0)::real
             FROM tasks t
             WHERE t.plan_id = p.id), 0::real)
         END AS computed_progress,
         p.progress_manual
  FROM smrtplan_plans p
)
SELECT plan_id,
       org_id,
       kind,
       computed_progress,
       COALESCE(progress_manual, computed_progress) AS effective_progress
FROM calc;

GRANT SELECT ON smrtplan_plan_progress TO anon, authenticated, service_role;
