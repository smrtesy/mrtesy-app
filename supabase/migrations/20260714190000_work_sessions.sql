-- work_sessions — the workclock day-tool's per-day work-time log
-- (docs/workclock-plan.md §7).
--
-- One row per user per day: when the work clock ran, how long, how it broke
-- down by task size, how many escalations fired, and how the day closed. Feeds
-- the "learning" view (avg workday, per-size averages, trends) and the
-- end-of-day close. The client (via /api/work-clock/*) maintains worked/paused
-- seconds off a monotonic started_at, and heartbeats persist here.
--
--   started_at / ended_at — session bounds (ended_at null while running/open).
--   worked_seconds        — active clock time (excludes paused).
--   paused_seconds        — time spent paused.
--   *_seconds (per size)  — time attributed to quick/medium/big active tasks.
--   alerts_*              — how many soft/popup/blocking escalations fired.
--   ritual_completed      — did the morning ritual reach "run".
--   closed_reason         — how the day ended (open until closed).

CREATE TABLE IF NOT EXISTS work_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_date        date NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  worked_seconds   integer NOT NULL DEFAULT 0 CHECK (worked_seconds  >= 0),
  paused_seconds   integer NOT NULL DEFAULT 0 CHECK (paused_seconds  >= 0),
  quick_seconds    integer NOT NULL DEFAULT 0 CHECK (quick_seconds   >= 0),
  medium_seconds   integer NOT NULL DEFAULT 0 CHECK (medium_seconds  >= 0),
  big_seconds      integer NOT NULL DEFAULT 0 CHECK (big_seconds     >= 0),
  alerts_soft      integer NOT NULL DEFAULT 0 CHECK (alerts_soft     >= 0),
  alerts_popup     integer NOT NULL DEFAULT 0 CHECK (alerts_popup    >= 0),
  alerts_block     integer NOT NULL DEFAULT 0 CHECK (alerts_block    >= 0),
  ritual_completed boolean NOT NULL DEFAULT false,
  closed_reason    text NOT NULL DEFAULT 'open'
                     CHECK (closed_reason IN ('open','manual','auto','extended')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_work_sessions_user_date
  ON work_sessions (user_id, work_date DESC);

ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;

-- Personal: a user reads and writes only their own sessions. Service role
-- (the backend + the rollover) bypasses RLS as usual.
DROP POLICY IF EXISTS work_sessions_own_select ON work_sessions;
CREATE POLICY work_sessions_own_select ON work_sessions
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS work_sessions_own_insert ON work_sessions;
CREATE POLICY work_sessions_own_insert ON work_sessions
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS work_sessions_own_update ON work_sessions;
CREATE POLICY work_sessions_own_update ON work_sessions
  FOR UPDATE USING (user_id = auth.uid());

COMMENT ON TABLE work_sessions IS
  'One row per user per day for the workclock day-tool: work-time log + '
  'the completion/close snapshot. See docs/workclock-plan.md §7.';

-- ── rollover: also close out any still-open work_sessions ──────────────────
-- Extends daily_rollover() (last defined in 20260712130000_daily_plans.sql).
-- Re-declares the existing daily_plans snapshot pass and the planned_for reset
-- pass UNCHANGED, and adds a pass that auto-closes past, still-open work
-- sessions (the safety net for a day the user forgot to stop).
CREATE OR REPLACE FUNCTION public.daily_rollover() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Pass 1 — snapshot & close out past daily_plans (before planned_for clears).
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

  -- Pass 2 — auto-close past, still-open work_sessions (workclock safety net).
  UPDATE work_sessions ws SET
    ended_at      = now(),
    closed_reason = 'auto',
    updated_at    = now()
  WHERE ws.closed_reason = 'open'
    AND ws.work_date < (
      now() AT TIME ZONE COALESCE(
        NULLIF((SELECT us.timezone FROM user_settings us
                WHERE us.user_id = ws.user_id
                  AND us.timezone IN (SELECT name FROM pg_timezone_names)), ''),
        'Asia/Jerusalem'
      )
    )::date;

  -- Pass 3 — the original per-user-timezone planned_for reset (unchanged).
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

REVOKE EXECUTE ON FUNCTION public.daily_rollover() FROM PUBLIC, anon, authenticated;
