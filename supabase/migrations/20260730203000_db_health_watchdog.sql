-- Early-warning DB-health watchdog (2026-07-30 resilience work, Layer 1).
-- Runs hourly and alerts on the leading pressure signals that preceded the
-- Disk-IO-budget collapse — BEFORE the instance becomes unresponsive — instead
-- of waiting for Supabase's late email. It cannot read the exact Disk-IO budget
-- % (that lives only in Supabase's metrics endpoint, which needs the
-- service_role key); it watches the in-DB symptoms we actually saw in the logs:
-- connection saturation, stuck queries, low cache-hit ratio (disk-read
-- pressure) and autovacuum falling behind.
--
-- Output: one log_entries row (level='error', category='db_health') — the daily
-- health-check Routine already groups these — PLUS a real-time inbox
-- notification to each super-admin, deduped to once per 6h.
--
-- Zero paid API, zero new backend code, no external auth. Reversible via
-- cron.unschedule + DROP FUNCTION.

CREATE OR REPLACE FUNCTION public.db_health_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conn_pct  numeric;
  v_longest_s numeric;
  v_cache_pct numeric;
  v_max_dead  bigint;
  v_issues    text[] := '{}';
  v_msg       text;
  v_admin     record;
  v_org       uuid;
  v_recent    int;
BEGIN
  SELECT round(100.0 * count(*) / current_setting('max_connections')::int, 1)
    INTO v_conn_pct FROM pg_stat_activity;

  -- Only real client queries — exclude background workers (walsender/Realtime,
  -- autovacuum) and this function's own call.
  SELECT round(extract(epoch FROM max(now() - query_start)))
    INTO v_longest_s
    FROM pg_stat_activity
   WHERE state = 'active'
     AND backend_type = 'client backend'
     AND query NOT ILIKE '%db_health_watchdog%';

  SELECT round(100.0 * sum(blks_hit) / nullif(sum(blks_hit) + sum(blks_read), 0), 2)
    INTO v_cache_pct FROM pg_stat_database;

  SELECT max(n_dead_tup) INTO v_max_dead FROM pg_stat_user_tables;

  IF v_conn_pct >= 70 THEN
    v_issues := v_issues || format('חיבורים %s%% מהמקסימום', v_conn_pct);
  END IF;
  IF v_longest_s >= 120 THEN
    v_issues := v_issues || format('שאילתה רצה כבר %s שניות', v_longest_s);
  END IF;
  IF v_cache_pct < 95 THEN
    v_issues := v_issues || format('יחס cache-hit %s%% (לחץ קריאה מהדיסק)', v_cache_pct);
  END IF;
  IF v_max_dead >= 100000 THEN
    v_issues := v_issues || format('%s שורות מתות (autovacuum מפגר)', v_max_dead);
  END IF;

  IF array_length(v_issues, 1) IS NULL THEN
    RETURN; -- healthy
  END IF;

  v_msg := 'אזהרת בריאות DB: ' || array_to_string(v_issues, '; ');

  -- One error row for the daily health-check report (user_id is nullable —
  -- this is a system-level alert, not tied to a tenant user).
  INSERT INTO log_entries (level, category, status, error_message)
  VALUES ('error', 'db_health', 'failed', v_msg);

  -- Real-time inbox alert to each super-admin, deduped to once per 6h.
  FOR v_admin IN SELECT user_id FROM super_admins LOOP
    SELECT org_id INTO v_org FROM org_members WHERE user_id = v_admin.user_id LIMIT 1;
    IF v_org IS NULL THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_recent
      FROM notifications
     WHERE user_id = v_admin.user_id
       AND entity_type = 'db_health'
       AND created_at > now() - interval '6 hours';

    IF v_recent = 0 THEN
      -- type is CHECK-constrained to info/warning/success/action_required.
      INSERT INTO notifications (user_id, org_id, app_slug, type, title, body, entity_type)
      VALUES (v_admin.user_id, v_org, 'smrttask', 'warning',
              'אזהרת בריאות מסד הנתונים', v_msg, 'db_health');
    END IF;
  END LOOP;
END $$;

-- Hourly.
SELECT cron.unschedule('db-health-watchdog')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'db-health-watchdog');
SELECT cron.schedule('db-health-watchdog', '0 * * * *', 'SELECT public.db_health_watchdog();');
