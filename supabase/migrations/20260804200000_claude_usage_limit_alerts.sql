-- Pre-emptive alerts when a Claude subscription account nears its 5-hour limit.
--
-- Why this exists: the console + tools run Claude on a subscription (per-account
-- CLAUDE_CODE_OAUTH_TOKEN, e.g. ai3/ai4). The subscription's 5-hour and weekly
-- limits are shared across every surface, and hitting them stops work with NO
-- warning — that surprise is the problem we're solving. Anthropic exposes no
-- programmatic quota/remaining feed on Team/Pro/Max (Analytics API is
-- Enterprise-only; even `/usage` is "approximate, local to this machine"). See
-- docs/claude-console/feasibility.md Q1.
--
-- So we ESTIMATE consumption from OUR OWN data — the per-run cost-equivalent the
-- CLI reports (claude_runs.total_cost_usd), which already normalises input/output/
-- cache into a single figure much closer to what the limit counts than raw token
-- sums. We compare the running 5-hour total against a CALIBRATED cap learned from
-- real limit-hit events (runner.ts parks a usage-limited run with
-- 'usage-limit-wait:until=<iso>;…' and the reset time), and alert at 70% and 90%.
--
-- Honest limitations (surface these; do not let the numbers read as exact):
--  * It's an ESTIMATE, not Anthropic's real %. It only counts usage that flowed
--    through our tools for that account — not claude.ai or a personal CLI on the
--    same account.
--  * The 5-hour window is Anthropic's rolling-fixed window: it starts at the
--    first request and resets 5h later. We reconstruct the current window's
--    anchor by walking requests forward in 5h hops.
--  * WEEKLY alerts are intentionally NOT sent here: we have zero weekly limit-hit
--    events to calibrate a cap, so a weekly threshold would be a pure guess. The
--    weekly figure is display-only (the composer card), until a weekly hit
--    calibrates it.
--
-- Additive: two new objects + reads of existing tables. No existing data changes.

-- ---------------------------------------------------------------------------
-- 1. Calibrated caps, one row per (account, window_kind). '*' = global default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_usage_limits (
  claude_account text NOT NULL,
  window_kind    text NOT NULL CHECK (window_kind IN ('session', 'weekly')),
  cap_cost_usd   numeric(12, 4) NOT NULL CHECK (cap_cost_usd > 0),
  note           text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (claude_account, window_kind)
);

COMMENT ON TABLE claude_usage_limits IS
  'Calibrated cost-equivalent caps per Claude account/window for the usage-limit '
  'estimator. cap_cost_usd is an equivalent-API-cost proxy (claude_runs.total_cost_usd), '
  'NOT money owed on the subscription. Learned from real limit-hit events; '
  'account=''*'' is the fallback default.';

-- Seed from what we actually know (2026-08-04): the single calibration point is
-- ai3 hitting its session limit at 13:41 NY after ~$19 of cost-equivalent in the
-- window. Global default is deliberately conservative so a new account alerts
-- early rather than late. Weekly default is a placeholder (display-only).
INSERT INTO claude_usage_limits (claude_account, window_kind, cap_cost_usd, note) VALUES
  ('*',   'session', 18,  'ברירת מחדל גלובלית — חשבון שטרם כויל'),
  ('ai3', 'session', 19,  'כויל ממיצוי 2026-08-04 13:41 NY: cost שווה-ערך עד המיצוי ≈ $19'),
  ('*',   'weekly',  200, 'placeholder — אין עדיין אירוע מיצוי שבועי לכיול; תצוגה בלבד')
ON CONFLICT (claude_account, window_kind) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The estimator. Returns one status row per active account (for diagnostics /
--    the composer card) AND, unless p_dry_run, files a notification to every
--    super-admin the first time each (window, threshold) is crossed.
-- ---------------------------------------------------------------------------
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

COMMENT ON FUNCTION public.check_claude_usage_limits(boolean) IS
  'Estimates each active Claude account''s consumption in its current 5-hour '
  'window (from claude_runs.total_cost_usd) vs a calibrated cap, and files a '
  'super-admin notification at 70% and 90%. p_dry_run=true returns the status '
  'rows without writing notifications. Weekly is display-only (uncalibrated).';

-- ---------------------------------------------------------------------------
-- 3. Run every 15 minutes. SQL-only (no LLM call), so zero paid tokens — the
--    same pattern as cross-party-merge-monitor. unschedule-first makes re-apply
--    idempotent.
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('claude-usage-limit-monitor')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'claude-usage-limit-monitor');

SELECT cron.schedule(
  'claude-usage-limit-monitor',
  '*/15 * * * *',
  $$SELECT public.check_claude_usage_limits();$$
);
