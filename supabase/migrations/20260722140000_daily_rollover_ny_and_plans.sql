-- daily_rollover() — restore the daily_plans snapshot + default to New York.
--
-- Two fixes in one redefinition of the nightly rollover:
--
--   1. Regression restore. 20260712130000_daily_plans.sql gave daily_rollover()
--      a Pass-1 that scores & closes each past, still-open daily_plans row
--      BEFORE Pass-2 clears planned_for. The later 20260720223... return_count
--      migration (20260720120000_task_return_count.sql) re-created the function
--      from the pre-daily_plans body and silently DROPPED Pass-1, so days have
--      not been scored/closed since. This brings Pass-1 back, keeping the
--      return_count increment the later migration added to Pass-2.
--
--   2. Timezone default → America/New_York. The team is in New York
--      (see CLAUDE.md "Timezone — always New York"), so a user with no
--      user_settings.timezone must roll at New York local midnight, not Israel's
--      (~7h early). Every AT TIME ZONE COALESCE(...) fallback below is
--      'America/New_York' instead of the old 'Asia/Jerusalem'. A user with an
--      explicit, valid IANA timezone still rolls in their own zone (unchanged).
--
-- Still one SECURITY DEFINER function, run hourly at :05 by the existing
-- 'daily-method-rollover' pg_cron job (20260707190000_daily_rollover_cron.sql) —
-- redefining the body is enough, no re-schedule. Both passes stay idempotent:
-- Pass-1 guards on closed_at IS NULL, Pass-2 on planned_for IS NOT NULL, so an
-- hourly re-run within the same local day is a no-op for already-processed rows.
CREATE OR REPLACE FUNCTION public.daily_rollover() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Pass 1 — snapshot & close out past days (before planned_for is cleared).
  -- Completion is measured by completed_at (the genuine "done" stamp), not by
  -- status: a /complete task is archived WITH completed_at; a stale-archived
  -- task has status=archived but NO completed_at and must not count as done.
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
               'America/New_York'))::date = dp.plan_date
    ),
    closed_at  = now(),
    updated_at = now()
  WHERE dp.closed_at IS NULL
    AND dp.plan_date < (
      now() AT TIME ZONE COALESCE(
        NULLIF((SELECT us.timezone FROM user_settings us
                WHERE us.user_id = dp.user_id
                  AND us.timezone IN (SELECT name FROM pg_timezone_names)), ''),
        'America/New_York'
      )
    )::date;

  -- Pass 2 — the per-user-timezone planned_for reset + return_count bump.
  -- Once a committed day passes without completion, un-plan it (it returns to
  -- the inbox as backlog) and record the slip. Idempotent: once planned_for is
  -- NULL the row no longer matches, so each slip increments exactly once.
  UPDATE tasks t
     SET planned_for = NULL,
         return_count = t.return_count + 1
  WHERE t.planned_for IS NOT NULL
    AND t.status NOT IN ('completed', 'archived', 'dismissed')
    AND t.planned_for < (
      now() AT TIME ZONE COALESCE(
        -- Guard: only accept a real IANA zone. An unrecognized string would make
        -- AT TIME ZONE throw and abort this one set-based UPDATE for EVERY user,
        -- silently, on every hourly run — so a bad row falls through to the default.
        NULLIF((SELECT us.timezone FROM user_settings us
                WHERE us.user_id = t.user_id
                  AND us.timezone IN (SELECT name FROM pg_timezone_names)), ''),
        'America/New_York'
      )
    )::date;
$$;

-- Cron/service only — never exposed on the public API (mirrors the prior def).
REVOKE EXECUTE ON FUNCTION public.daily_rollover() FROM PUBLIC, anon, authenticated;

-- The 'daily-method-rollover' pg_cron job already calls public.daily_rollover()
-- hourly at :05 — replacing the function body is enough, no re-schedule needed.
