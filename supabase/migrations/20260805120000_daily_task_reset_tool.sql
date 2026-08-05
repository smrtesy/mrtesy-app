-- Day-tool "איפוס יומי" (dailyreset) — full return-to-inbox nightly reset.
--
-- User decision (2026-08-05): the daily reset becomes an opt-in day-tool,
-- OFF by default for everyone. When ON for a user, every night at that user's
-- LOCAL midnight, every OPEN task that was not completed and not postponed to a
-- future date is pulled back to a clean inbox. The existing planned_for-only
-- daily_rollover() (the מהיר·3·1 pick flow) is left untouched — this is an
-- additive, separately-gated mechanism.
--
-- Why this is broader than daily_rollover(): that function only clears
-- planned_for, so a task the user never "picked for today" (planned_for NULL)
-- or a task sitting in 'in_progress' never reset. In practice that meant the
-- reset touched almost nothing (the reporting user had 0 open tasks with
-- planned_for). This resets by the ACTUAL surfaced/active state instead.
--
-- The reset, per the approved spec:
--   status = 'in_progress'                       → back to 'inbox' (+ badge)
--   status = 'inbox' with today_position/planned  → today markers cleared
--   future-dated (due_date > local today)         → left alone (postponed)
--   snoozed / pending_completion / completed /
--     archived / dismissed                        → left alone
--   already-clean inbox (no today markers, no date) → no-op
-- pending_completion is deliberately excluded: it is a done-signal (often from
-- a Claude session) awaiting the user's confirm, not a hiding task.

-- ── Marker: which local date we last reset this user on (additive) ──────────
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS last_daily_reset_on date;

COMMENT ON COLUMN user_settings.last_daily_reset_on IS
  'Local date (in the user timezone) daily_task_reset() last ran for this user. '
  'Gates the nightly full-return-to-inbox reset to once per local day. NULL = never.';

-- ── The reset function ─────────────────────────────────────────────────────
-- One SECURITY DEFINER function, run hourly by pg_cron. Hourly (not daily)
-- because each user's LOCAL midnight lands in a different UTC hour and shifts
-- with DST; the per-user marker makes it fire exactly once per local day (the
-- other 23 runs are near-instant no-ops). Same rationale as daily_rollover().
CREATE OR REPLACE FUNCTION public.daily_task_reset() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_local_today date;
BEGIN
  FOR r IN
    SELECT
      us.user_id,
      -- Only accept a real IANA zone; otherwise default to New York (the team's
      -- zone — see CLAUDE.md). Mirrors daily_rollover()'s guard.
      COALESCE(
        NULLIF((SELECT us2.timezone FROM user_settings us2
                WHERE us2.user_id = us.user_id
                  AND us2.timezone IN (SELECT name FROM pg_timezone_names)), ''),
        'America/New_York'
      ) AS tz,
      us.last_daily_reset_on
    FROM user_settings us
    WHERE (us.day_tools -> 'dailyreset' ->> 'enabled') = 'true'
  LOOP
    v_local_today := (now() AT TIME ZONE r.tz)::date;

    -- Once per local day. First run after local midnight does the work; the
    -- rest of the day is skipped so a task started mid-day is NOT yanked back
    -- until the next day turns over.
    CONTINUE WHEN r.last_daily_reset_on IS NOT DISTINCT FROM v_local_today;

    UPDATE tasks t
       SET status = 'inbox',
           planned_for = NULL,
           today_position = NULL,
           return_count = t.return_count + 1,
           status_changed_at = CASE WHEN t.status <> 'inbox' THEN now() ELSE t.status_changed_at END,
           last_updated_reason = 'daily_reset',
           updated_at = now()
     WHERE t.user_id = r.user_id
       -- Open, non-snoozed, not awaiting a done-confirmation.
       AND t.status IN ('inbox', 'in_progress')
       -- Only surfaced/active rows: in progress, or carrying a today marker.
       -- An already-clean inbox row (no markers) is left untouched (no badge bump).
       AND (t.status = 'in_progress' OR t.planned_for IS NOT NULL OR t.today_position IS NOT NULL)
       -- Postponed to a future date → left alone. due_date = today still returns.
       AND (t.due_date IS NULL OR t.due_date <= v_local_today);

    UPDATE user_settings
       SET last_daily_reset_on = v_local_today
     WHERE user_id = r.user_id;
  END LOOP;
END$$;

-- Cron/service only — never exposed on the public API.
REVOKE EXECUTE ON FUNCTION public.daily_task_reset() FROM PUBLIC, anon, authenticated;

-- Hourly at :07 (offset from daily_rollover's :05). Unschedule first so this is
-- re-runnable; skipped cleanly when pg_cron isn't installed (local dev).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('daily-task-reset')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-task-reset');
    PERFORM cron.schedule(
      'daily-task-reset',
      '7 * * * *',
      $cron$SELECT public.daily_task_reset();$cron$
    );
    RAISE NOTICE '[daily-task-reset] scheduled hourly at :07.';
  ELSE
    RAISE NOTICE '[daily-task-reset] pg_cron not installed — schedule skipped.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[daily-task-reset] cron setup skipped: %', SQLERRM;
END$$;
