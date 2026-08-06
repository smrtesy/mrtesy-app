-- Auto-calibrate each account's usage-limit cap from Anthropic's OWN ground
-- truth, captured on rate_limit_event lines (see 20260805230000).
--
-- The estimator (check_claude_usage_limits) compares an account's summed run
-- cost in its window against a CALIBRATED cap. The cap used to be hand-set (a
-- single '*' default, seeded $18 → hand-raised to $70 → $65). Now we can learn
-- it per account: whenever Anthropic reports a real utilization (0.90+ for the
-- 5-hour window, 0.75+ for weekly), the cap that would have made our estimate
-- exact is  cost_in_window / utilization . The median of those points is the
-- calibrated cap.
--
-- Accuracy depends on ALL of an account's usage flowing through our tools (a
-- request made on claude.ai / another CLI on the same account is consumption we
-- never see, which drags cost — hence utilization — off). For accounts used
-- EXCLUSIVELY via this platform (ai3/ai4, per the operator's decision on
-- 2026-08-06) the cost is complete, so the implied cap is stable and the
-- calibration converges on the true number. The median is robust to the few
-- noisy points left from earlier external use, which age out of the 7-day window.
--
-- The '*' default cap stays operator-set (currently $65); this only writes
-- per-account rows, and only when >=3 ground-truth points exist and the median
-- is in a sane $5..$500 band (a guard against a degenerate cap from noise).
--
-- Additive: one function + one cron job. No existing data changed by the DDL
-- (the function UPSERTs caps at RUN time, like check_claude_usage_limits files
-- notifications at run time).

CREATE OR REPLACE FUNCTION public.recalibrate_claude_usage_caps()
RETURNS TABLE (out_account text, out_window_kind text, out_new_cap numeric, out_points integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  r record;
BEGIN
  FOR r IN
    WITH pts AS (
      -- One row per rate_limit_event that carried a real utilization, with the
      -- window it belongs to reconstructed from Anthropic's exact resetsAt.
      SELECT
        coalesce(cr.claude_account, 'primary') AS acct,
        CASE WHEN e.payload->'rate_limit_info'->>'rateLimitType' = 'five_hour'
             THEN 'session' ELSE 'weekly' END AS wkind,
        (e.payload->'rate_limit_info'->>'utilization')::numeric AS util,
        to_timestamp((e.payload->'rate_limit_info'->>'resetsAt')::bigint) AS resets_at,
        e.created_at AS event_time,
        CASE WHEN e.payload->'rate_limit_info'->>'rateLimitType' = 'five_hour'
             THEN interval '5 hours' ELSE interval '7 days' END AS win
      FROM claude_run_events e
      JOIN claude_runs cr ON cr.id = e.run_id
      WHERE e.payload->>'type' = 'rate_limit_event'
        AND e.payload->'rate_limit_info' ? 'utilization'
        AND (e.payload->'rate_limit_info'->>'utilization') ~ '^[0-9.]+$'
        -- Only points from a window where OUR cost is the WHOLE consumption.
        -- Before 2026-08-06 the accounts were also used on claude.ai / other
        -- CLIs, so cost was incomplete and the implied cap came out far too low
        -- (ai3 → $21 from a $70 window). The operator went platform-exclusive on
        -- ai3/ai4 that day; ignore anything earlier. The floor is a greatest()
        -- with now()-7d, so once a full clean week has passed it dissolves back
        -- into the plain rolling 7-day window with no magic date lingering.
        AND e.created_at >= greatest(now() - interval '7 days', timestamptz '2026-08-06 00:00:00-04')
    ),
    implied AS (
      -- cap that would have made our estimate match Anthropic at that moment.
      SELECT
        p.acct, p.wkind,
        (SELECT sum(rr.total_cost_usd) FROM claude_runs rr
           WHERE coalesce(rr.claude_account, 'primary') = p.acct
             AND rr.created_at >= p.resets_at - p.win
             AND rr.created_at <= p.event_time) / NULLIF(p.util, 0) AS cap
      FROM pts p
    )
    SELECT
      acct AS a,
      wkind AS wk,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY cap)::numeric, 2) AS med_cap,
      count(*)::int AS n
    FROM implied
    WHERE cap IS NOT NULL AND cap > 0
    GROUP BY acct, wkind
    HAVING count(*) >= 3
       AND percentile_cont(0.5) WITHIN GROUP (ORDER BY cap) BETWEEN 5 AND 500
  LOOP
    INSERT INTO claude_usage_limits (claude_account, window_kind, cap_cost_usd, note, updated_at)
    VALUES (
      r.a, r.wk, r.med_cap,
      'auto-calib ' || to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')
        || ' NY: median implied cap from ' || r.n || ' rate_limit_event ground-truth points (7d window)',
      now()
    )
    ON CONFLICT (claude_account, window_kind)
    DO UPDATE SET
      cap_cost_usd = EXCLUDED.cap_cost_usd,
      note = EXCLUDED.note,
      updated_at = now();

    out_account := r.a;
    out_window_kind := r.wk;
    out_new_cap := r.med_cap;
    out_points := r.n;
    RETURN NEXT;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.recalibrate_claude_usage_caps() IS
  'Learns each Claude account''s usage-limit cap from real rate_limit_event '
  'utilizations (cost/utilization = implied cap; median over 7 days). Writes '
  'per-account rows in claude_usage_limits when >=3 points exist; leaves the '
  'operator-set ''*'' default alone. Run hourly by cron.';

-- Run hourly at :17 (off the :*/15 monitor, off the top of the hour).
SELECT cron.unschedule('claude-usage-recalibrate')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'claude-usage-recalibrate');

SELECT cron.schedule(
  'claude-usage-recalibrate',
  '17 * * * *',
  $$SELECT public.recalibrate_claude_usage_caps();$$
);
