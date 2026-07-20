-- Return count for the daily-method rollover (fixes the recurring
-- "אישור/בינוני נכנס ל'לתכנן להיום'" bug — T1594, T1532).
--
-- Background: the inbox derived a "לתכנן להיום" (plan-today) bucket purely
-- client-side from EVERY verified, undated, non-quick task
-- (size != 'quick' AND due_date IS NULL AND planned_for != today). That meant a
-- freshly-approved proposal (manually_verified=true, no date, size defaults to
-- 'medium') — or any task flipped to 'medium' — was swept into that bucket
-- instead of just living on the desk. That was the recurring bug.
--
-- New model: an approved / undated task goes straight to the desk. It only
-- comes BACK to the inbox when it genuinely "returns" — i.e. it was committed to
-- a day (planned_for) and that day passed without completion, so the nightly
-- rollover nulls planned_for. return_count records how many times that happened;
-- the inbox shows a "×N" badge on those returned tasks (return_count >= 1).

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS return_count integer NOT NULL DEFAULT 0
    CHECK (return_count >= 0);

COMMENT ON COLUMN tasks.return_count IS
  'How many times daily_rollover() has un-planned this task (planned_for was set to a past day and the task was not completed). Drives the inbox "×N returned" badge.';

-- Fold the increment into the existing per-user-timezone rollover. Still one
-- set-based UPDATE and still idempotent: once planned_for is NULL the row no
-- longer matches the WHERE, so each slip increments exactly once (the hourly
-- re-runs within the same day are no-ops for an already-rolled row). Body is
-- copied verbatim from 20260708210000_daily_rollover_per_user_tz.sql, with the
-- single addition of `return_count = t.return_count + 1`.
CREATE OR REPLACE FUNCTION public.daily_rollover() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
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
        'Asia/Jerusalem'
      )
    )::date;
$$;

-- Cron/service only — never exposed on the public API.
REVOKE EXECUTE ON FUNCTION public.daily_rollover() FROM PUBLIC, anon, authenticated;

-- The 'daily-method-rollover' pg_cron job (20260707190000_daily_rollover_cron.sql)
-- already calls public.daily_rollover() hourly at :05 — replacing the function
-- body is enough, no re-schedule needed.
