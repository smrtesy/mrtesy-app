-- ============================================================
-- smrtPlan — progress & health views (engine §2 ג/ד, §4)
-- ============================================================
-- Light computations (counting) run as VIEWs rather than Edge Functions, per
-- engine §4 ("חישובים קלים → VIEW / לקוח"). The heavy graph work (backward
-- scheduling, critical path, dependency release) lives in the Edge Functions.
--
-- security_invoker = true → the view runs with the *caller's* RLS, so a browser
-- client only ever sees rows it is already allowed to see. The Express
-- service-role client bypasses RLS as usual.

-- ─── Plan progress (ג) ───────────────────────────────────────
-- effort  → completed tasks / total tasks under the plan
-- stream  → done matrix cells / total cells under the plan
-- effective progress = manual override when present, else computed.
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
      SELECT count(*) FILTER (WHERE t.status IN ('completed', 'archived'))::real
             / NULLIF(count(*), 0)::real
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
        SELECT count(*) FILTER (WHERE t.status IN ('completed', 'archived'))::real
               / NULLIF(count(*), 0)::real
        FROM tasks t
        WHERE t.plan_id = p.id
      ), 0)
    END
  ) AS effective_progress
FROM smrtplan_plans p;

-- ─── Task health (ד) — path-based with interim fallback ──────
-- late     = open task past its latest_finish (or due_date, before the path is built)
-- at_risk  = latest_start (or due_date) within 3 days, not yet started
-- on_track = everything else
-- The 3-day threshold is hard-coded here; org-level tuning can override in API.
CREATE OR REPLACE VIEW smrtplan_task_health
WITH (security_invoker = true) AS
SELECT
  t.id              AS task_id,
  t.organization_id AS org_id,
  t.plan_id         AS plan_id,
  t.is_critical     AS is_critical,
  COALESCE(t.latest_finish, t.due_date) AS effective_finish,
  COALESCE(t.latest_start,  t.due_date) AS effective_start,
  CASE
    WHEN t.status IN ('completed', 'archived', 'dismissed') THEN 'done'
    WHEN COALESCE(t.latest_finish, t.due_date) IS NOT NULL
         AND COALESCE(t.latest_finish, t.due_date) < CURRENT_DATE THEN 'late'
    WHEN COALESCE(t.latest_start, t.due_date) IS NOT NULL
         AND COALESCE(t.latest_start, t.due_date) <= CURRENT_DATE + 3
         AND t.status = 'inbox' THEN 'at_risk'
    ELSE 'on_track'
  END AS health
FROM tasks t;
