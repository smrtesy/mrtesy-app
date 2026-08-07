-- Fix: "column reference claude_account is ambiguous" in check_claude_usage_limits.
--
-- The function's RETURNS TABLE declares an OUT column named claude_account, which
-- is an in-scope plpgsql variable throughout the body. The two auto-calibration
-- UPDATE statements filter `WHERE claude_account = '*'` with a BARE column name,
-- so Postgres cannot tell the OUT variable from claude_usage_limits.claude_account
-- and errors out. plpgsql plans a statement on first execution, so this only
-- surfaced once >= 3 session exhaustion events accumulated (2026-08-06 evening) and
-- the calibration UPDATE actually ran — after which the monitor cron failed on
-- every 15-min tick.
--
-- Fix: table-qualify the column in both WHERE clauses. Body is otherwise identical
-- to 20260805120000_claude_usage_hits.sql. CREATE OR REPLACE — reversible, no data
-- touched.

CREATE OR REPLACE FUNCTION public.check_claude_usage_limits(p_dry_run boolean DEFAULT false)
RETURNS TABLE (
  claude_account    text,
  window_start      timestamptz,
  window_end        timestamptz,
  cost_used         numeric,
  cap_cost          numeric,
  pct               integer,
  threshold_crossed integer,
  alerted           boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  r_acct    record;
  r_admin   record;
  v_anchor  timestamptz;
  v_next    timestamptz;
  v_end     timestamptz;
  v_cost    numeric;
  v_cap     numeric;
  v_pct     integer;
  v_thr     integer;
  v_entity  text;
  v_reset   text;
BEGIN
  -- ── Auto-calibration ────────────────────────────────────────────────────
  -- Learn the shared session cap from real exhaustion events instead of a
  -- hand-set number. Each claude_usage_hits row marks a window that ended in
  -- exhaustion (append-only ground truth); we recompute that window's FULL cost
  -- LIVE from claude_runs — not the row's first-hit snapshot, which undercounts a
  -- blind park that flickered on and kept running to the real reset (test 5) — and
  -- take the median across events. All accounts are Max 5x (one tier) so they share
  -- the '*' cap: more points, faster convergence, and a NEW account inherits it with
  -- zero manual fix (the exact ai4-showed-148%-on-the-default failure this prevents).
  -- Held back until >= v_min_session_hits real events so the hand-calibrated baseline
  -- ($58, from the first two pre-table events) governs until the table has enough of
  -- its own ground truth. Runs every 15 min inside the same cron — no extra job.
  DECLARE
    v_min_session_hits constant integer := 3;  -- test 1: 2 is assured, >=3 proven
    v_min_weekly_hits  constant integer := 1;  -- test 4: weekly needs >=1 to calibrate
    v_n_sess integer;
    v_n_week integer;
    v_new    numeric;
  BEGIN
    -- Only the cron (p_dry_run=false) recalibrates. The meter endpoint calls this
    -- dry-run on every mount + every 60s while its popover is open — a screen READ
    -- must never write to claude_usage_limits (and re-running calibration on every
    -- read would fire it far more often than the intended 15-min cron cadence).
    IF NOT p_dry_run THEN
    SELECT count(*) INTO v_n_sess FROM claude_usage_hits WHERE kind = 'session';
    IF v_n_sess >= v_min_session_hits THEN
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY w.cost) INTO v_new
      FROM (
        SELECT (
          SELECT coalesce(sum(cr.total_cost_usd), 0)
          FROM claude_runs cr
          WHERE cr.claude_account = h.claude_account
            AND cr.created_at >= h.window_start
            AND cr.created_at <  h.window_end
        ) AS cost
        FROM claude_usage_hits h
        WHERE h.kind = 'session'
      ) w
      WHERE w.cost > 0;
      IF v_new IS NOT NULL AND v_new > 0 THEN
        UPDATE claude_usage_limits
        SET cap_cost_usd = round(v_new, 2),
            note = format('כויל אוטומטית מ-%s אירועי-מיצוי (חציון cost בחלון מלא) %s NY',
                          v_n_sess,
                          to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')),
            updated_at = now()
        WHERE claude_usage_limits.claude_account = '*' AND window_kind = 'session';
      END IF;
    END IF;

    SELECT count(*) INTO v_n_week FROM claude_usage_hits WHERE kind = 'weekly';
    IF v_n_week >= v_min_weekly_hits THEN
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY w.cost) INTO v_new
      FROM (
        SELECT (
          SELECT coalesce(sum(cr.total_cost_usd), 0)
          FROM claude_runs cr
          WHERE cr.claude_account = h.claude_account
            AND cr.created_at >= h.window_start
            AND cr.created_at <  h.window_end
        ) AS cost
        FROM claude_usage_hits h
        WHERE h.kind = 'weekly'
      ) w
      WHERE w.cost > 0;
      IF v_new IS NOT NULL AND v_new > 0 THEN
        UPDATE claude_usage_limits
        SET cap_cost_usd = round(v_new, 2),
            note = format('כויל אוטומטית מ-%s אירועי-מיצוי שבועיים (חציון cost) %s NY',
                          v_n_week,
                          to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI')),
            updated_at = now()
        WHERE claude_usage_limits.claude_account = '*' AND window_kind = 'weekly';
      END IF;
    END IF;
    END IF;  -- NOT p_dry_run
  END;

  FOR r_acct IN
    SELECT DISTINCT cr.claude_account AS acct
    FROM claude_runs cr
    WHERE cr.claude_account IS NOT NULL
      AND cr.created_at > now() - interval '8 days'
  LOOP
    -- Reconstruct the current 5-hour window's anchor. Seed at a real window
    -- BOUNDARY — the earliest request in the last 24h that has NO request in the
    -- 5h before it (a ≥5h gap marks a fresh window start) — then hop forward 5h
    -- at a time to the first request of each subsequent window, until the window
    -- contains now(). Seeding at a raw min() could sit mid-window and offset
    -- every hop by up to ~5h, mis-summing the window and mis-reporting the reset.
    SELECT min(cr.created_at) INTO v_anchor
    FROM claude_runs cr
    WHERE cr.claude_account = r_acct.acct
      AND cr.created_at > now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM claude_runs p
        WHERE p.claude_account = r_acct.acct
          AND p.created_at >= cr.created_at - interval '5 hours'
          AND p.created_at <  cr.created_at
      );

    -- Continuous 24h+ with no ≥5h gap → no boundary in range; fall back to the
    -- last 5h so a very busy account is still monitored (window approximate).
    IF v_anchor IS NULL THEN
      SELECT min(cr.created_at) INTO v_anchor
      FROM claude_runs cr
      WHERE cr.claude_account = r_acct.acct AND cr.created_at > now() - interval '5 hours';
    END IF;

    IF v_anchor IS NULL THEN
      CONTINUE;
    END IF;

    LOOP
      EXIT WHEN v_anchor + interval '5 hours' > now();
      SELECT min(cr.created_at) INTO v_next
      FROM claude_runs cr
      WHERE cr.claude_account = r_acct.acct AND cr.created_at >= v_anchor + interval '5 hours';
      EXIT WHEN v_next IS NULL;
      v_anchor := v_next;
    END LOOP;

    v_end := v_anchor + interval '5 hours';

    -- Window already elapsed with no activity carrying into now() → nothing live.
    IF now() >= v_end THEN
      CONTINUE;
    END IF;

    SELECT coalesce(sum(coalesce(cr.total_cost_usd, 0)), 0) INTO v_cost
    FROM claude_runs cr
    WHERE cr.claude_account = r_acct.acct
      AND cr.created_at >= v_anchor AND cr.created_at < v_end;

    SELECT cul.cap_cost_usd INTO v_cap FROM claude_usage_limits cul
    WHERE cul.claude_account = r_acct.acct AND cul.window_kind = 'session';
    IF v_cap IS NULL THEN
      SELECT cul.cap_cost_usd INTO v_cap FROM claude_usage_limits cul
      WHERE cul.claude_account = '*' AND cul.window_kind = 'session';
    END IF;
    IF v_cap IS NULL OR v_cap <= 0 THEN
      v_cap := 18;
    END IF;

    v_pct := floor(v_cost / v_cap * 100)::integer;

    -- Highest crossed threshold wins (90 before 70). A jump straight past 90
    -- skips the 70 alert on purpose — no point nagging at 70 once already at 90.
    v_thr := NULL;
    IF v_pct >= 90 THEN
      v_thr := 90;
    ELSIF v_pct >= 70 THEN
      v_thr := 70;
    END IF;

    IF v_thr IS NOT NULL AND NOT p_dry_run THEN
      -- Dedup: the anchor epoch is in entity_type, so each new window is a new
      -- key and re-alerts; within a window each threshold fires at most once.
      v_entity := 'claude-usage:' || r_acct.acct || ':session:' || v_thr || ':'
                  || floor(extract(epoch FROM v_anchor))::bigint;

      IF NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE entity_type = v_entity AND created_at > now() - interval '6 hours'
      ) THEN
        v_reset := to_char(v_end AT TIME ZONE 'America/New_York', 'HH24:MI');
        FOR r_admin IN
          SELECT sa.user_id AS uid, om.org_id AS oid
          FROM super_admins sa
          JOIN LATERAL (
            SELECT org_id FROM org_members WHERE user_id = sa.user_id LIMIT 1
          ) om ON true
        LOOP
          INSERT INTO notifications (user_id, org_id, app_slug, type, title, body, link, entity_type)
          VALUES (
            r_admin.uid, r_admin.oid, 'smrttask',
            CASE WHEN v_thr >= 90 THEN 'action_required' ELSE 'warning' END,
            format('חשבון Claude %s — %s מחלון 5 השעות',
                   r_acct.acct,
                   CASE WHEN v_pct >= 100 THEN 'מוצה (100%+)' ELSE v_pct || '%' END),
            format(
              'נצרכו כ-$%s (כ-%s%%) מתוך תקרה מוערכת של ~$%s שווה-ערך. החלון מתאפס בסביבות %s שעון ניו יורק. '
              || 'זהו אומדן מהצריכה דרך הכלים שלנו — לא נתון רשמי מאנתרופיק.',
              round(v_cost, 1), least(v_pct, 100), round(v_cap, 0), v_reset
            ),
            '/claude', v_entity
          );
        END LOOP;
      END IF;
    END IF;

    claude_account    := r_acct.acct;
    window_start      := v_anchor;
    window_end        := v_end;
    cost_used         := round(v_cost, 2);
    cap_cost          := v_cap;
    pct               := v_pct;
    threshold_crossed := v_thr;
    alerted           := (v_thr IS NOT NULL AND NOT p_dry_run);
    RETURN NEXT;
  END LOOP;
END;
$function$;
