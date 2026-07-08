-- Daily-method rollover — per-user timezone (spec: "הגלגול היומי רץ בחצות
-- לפי אזור הזמן של המשתמש").
--
-- The original rollover compared planned_for against a single hardcoded
-- Asia/Jerusalem "today". A user in another timezone would have their picks
-- rolled at Israel midnight, not their own. This redefines daily_rollover()
-- to resolve each task's cutoff against that user's own timezone
-- (user_settings.timezone), falling back to Asia/Jerusalem when it's unset or
-- empty. Still a pure UPDATE run hourly by pg_cron: the DATE comparison keeps
-- it idempotent, and hourly is exactly right now that each user's local
-- midnight lands in a different hour.

CREATE OR REPLACE FUNCTION public.daily_rollover() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE tasks t SET planned_for = NULL
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

-- The 'daily-method-rollover' pg_cron job (created in
-- 20260707190000_daily_rollover_cron.sql) already calls public.daily_rollover()
-- hourly at :05, so replacing the function body is enough — no re-schedule.
