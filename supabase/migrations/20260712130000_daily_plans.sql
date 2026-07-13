-- daily_plans — the מהיר·3·1 day-tool's history/statistics table
-- (docs/day-tools-plan.md §3.3 / §6).
--
-- One row per user per day, written when the user "builds their day" (picks the
-- 3 medium + 1 big for today; all quick auto-enter) and closed out by the nightly
-- rollover, which snapshots how much of the committed day was actually done
-- BEFORE it clears planned_for (otherwise the picks are lost and the day can
-- never be scored). Feeds day-streaks, completion %, and the future evening
-- ritual — none of which can be reconstructed once rollover wipes planned_for.
--
--   picked_task_ids  — the medium/big tasks committed for the day (quick are
--                      not "picked": they all enter automatically).
--   quick_total      — count of quick tasks at build time (the day's quick load).
--   completed_*      — filled by the rollover at close (per size).
--   closed_at        — set once the rollover has scored the day (idempotent guard).

CREATE TABLE IF NOT EXISTS daily_plans (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_date        date NOT NULL,
  picked_task_ids  uuid[] NOT NULL DEFAULT '{}',
  quick_total      integer NOT NULL DEFAULT 0 CHECK (quick_total >= 0),
  completed_quick  integer NOT NULL DEFAULT 0 CHECK (completed_quick >= 0),
  completed_medium integer NOT NULL DEFAULT 0 CHECK (completed_medium >= 0),
  completed_big    integer NOT NULL DEFAULT 0 CHECK (completed_big >= 0),
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, plan_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_plans_user_date
  ON daily_plans (user_id, plan_date DESC);

ALTER TABLE daily_plans ENABLE ROW LEVEL SECURITY;

-- Personal: a user reads and writes only their own days. Service role (the
-- backend + the rollover) bypasses RLS as usual.
DROP POLICY IF EXISTS daily_plans_own_select ON daily_plans;
CREATE POLICY daily_plans_own_select ON daily_plans
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS daily_plans_own_insert ON daily_plans;
CREATE POLICY daily_plans_own_insert ON daily_plans
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS daily_plans_own_update ON daily_plans;
CREATE POLICY daily_plans_own_update ON daily_plans
  FOR UPDATE USING (user_id = auth.uid());

COMMENT ON TABLE daily_plans IS
  'One row per user per day for the מהיר·3·1 day-tool: the committed picks + '
  'the completion snapshot the rollover takes before clearing planned_for. '
  'See docs/day-tools-plan.md §3.3.';

-- ── rollover: score yesterday, THEN clear planned_for ──────────────────────
-- Extends daily_rollover() (20260708210000_daily_rollover_per_user_tz.sql) with
-- a first pass that closes out every past, still-open daily_plans row for the
-- user's own timezone, computing the completion counts while the picks are
-- still intact. The second pass is the original planned_for reset, unchanged.
--
-- Completion is measured by completed_at (the genuine "done" stamp set by
-- /complete), NOT by status: a task completed via /complete is status=archived
-- WITH completed_at, whereas a task archived-as-stale from the review banner
-- has status=archived but NO completed_at and must not count as done.
--   • medium/big — counted against the stored picked_task_ids (reliable even
--     though rollover keeps completed rows' planned_for).
--   • quick       — counted by completed_at landing on plan_date in the user's
--     own timezone (quick tasks are never "picked", so there is no id list).
CREATE OR REPLACE FUNCTION public.daily_rollover() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Pass 1 — snapshot & close out past days (before planned_for is cleared).
  UPDATE daily_plans dp SET
    completed_medium = (
      SELECT count(*) FROM tasks t
      WHERE t.id = ANY(dp.picked_task_ids)
        AND t.user_id = dp.user_id
        AND t.size = 'medium'
        AND t.completed_at IS NOT NULL
    ),
    completed_big = (
      SELECT count(*) FROM tasks t
      WHERE t.id = ANY(dp.picked_task_ids)
        AND t.user_id = dp.user_id
        AND t.size = 'big'
        AND t.completed_at IS NOT NULL
    ),
    completed_quick = (
      SELECT count(*) FROM tasks t
      WHERE t.user_id = dp.user_id
        AND t.size = 'quick'
        AND t.completed_at IS NOT NULL
        AND (t.completed_at AT TIME ZONE COALESCE(
               NULLIF((SELECT us.timezone FROM user_settings us
                       WHERE us.user_id = dp.user_id
                         AND us.timezone IN (SELECT name FROM pg_timezone_names)), ''),
               'Asia/Jerusalem'))::date = dp.plan_date
    ),
    closed_at  = now(),
    updated_at = now()
  WHERE dp.closed_at IS NULL
    AND dp.plan_date < (
      now() AT TIME ZONE COALESCE(
        NULLIF((SELECT us.timezone FROM user_settings us
                WHERE us.user_id = dp.user_id
                  AND us.timezone IN (SELECT name FROM pg_timezone_names)), ''),
        'Asia/Jerusalem'
      )
    )::date;

  -- Pass 2 — the original per-user-timezone planned_for reset (unchanged).
  UPDATE tasks t SET planned_for = NULL
  WHERE t.planned_for IS NOT NULL
    AND t.status NOT IN ('completed', 'archived', 'dismissed')
    AND t.planned_for < (
      now() AT TIME ZONE COALESCE(
        NULLIF((SELECT us.timezone FROM user_settings us
                WHERE us.user_id = t.user_id
                  AND us.timezone IN (SELECT name FROM pg_timezone_names)), ''),
        'Asia/Jerusalem'
      )
    )::date;
$$;

-- Cron/service only — never exposed on the public API (mirrors the prior def).
REVOKE EXECUTE ON FUNCTION public.daily_rollover() FROM PUBLIC, anon, authenticated;
