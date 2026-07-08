-- Daily-method rollover (docs artifact "smrtTask — שיטת היום").
--
-- Once the day turns over, yesterday's picks that were NOT finished should stop
-- counting as "Today" and drop back to the pool, so the user re-decides each
-- morning. Realised by clearing planned_for for any unfinished task planned for
-- a day before today. "today" is the app's local date (Asia/Jerusalem); since
-- planned_for is a DATE, this is idempotent — a task picked today is untouched
-- until after local midnight, and re-running mid-day is a no-op.
--
-- Pure SQL (an UPDATE) invoked by pg_cron hourly — no edge function needed.

CREATE OR REPLACE FUNCTION public.daily_rollover() RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE tasks SET planned_for = NULL
  WHERE planned_for IS NOT NULL
    AND planned_for < (now() AT TIME ZONE 'Asia/Jerusalem')::date
    AND status NOT IN ('completed', 'archived', 'dismissed');
$$;

-- Cron/service only — never exposed on the public API.
REVOKE EXECUTE ON FUNCTION public.daily_rollover() FROM PUBLIC, anon, authenticated;

-- Hourly (at :05). Unschedule first so the migration is re-runnable. Skipped
-- cleanly when pg_cron isn't installed (local dev), never breaks the chain.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('daily-method-rollover')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-method-rollover');
    PERFORM cron.schedule(
      'daily-method-rollover',
      '5 * * * *',
      $cron$SELECT public.daily_rollover();$cron$
    );
    RAISE NOTICE '[daily-method] scheduled daily-method-rollover (hourly at :05).';
  ELSE
    RAISE NOTICE '[daily-method] pg_cron not installed — rollover schedule skipped.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[daily-method] rollover cron setup skipped: %', SQLERRM;
END$$;
