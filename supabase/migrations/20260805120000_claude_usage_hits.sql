-- Append-only ground truth for the Claude usage-limit estimator + auto-calibration.
--
-- Why this exists (docs/claude-usage-calibration-process.md): the whole estimator
-- is only as good as its cap, and the ONLY moment we know a subscription account is
-- truly "100% used" is when it gets PARKED at its limit (runner.ts writes
-- error='usage-limit-wait:…'). That sign is DESTROYED when the recoverer resumes the
-- run (error flips to 'done'), so the exhaustion event has to be captured append-only
-- the instant it happens — a field that flips is not a ground truth. This migration:
--   1. claude_usage_hits         — one immutable row per (account, window) exhaustion.
--   2. record_claude_usage_hit() — runner.ts calls this at the park moment.
--   3. check_claude_usage_limits — now self-calibrates the cap from those events.
--
-- Additive: one new table + one new function + a CREATE OR REPLACE of an existing
-- function (no signature change). No existing data is modified or removed.

-- ---------------------------------------------------------------------------
-- 1. claude_usage_hits — append-only exhaustion registry.
--    One row per (account, window_kind, window_start). NEVER updated or deleted:
--    it is the historical ground truth. The metric columns are the snapshot AS OF
--    the first park in that window (cost_first_hit); the full-window cost the cap
--    is learned from is recomputed live from claude_runs at calibration time, so a
--    "flickering" blind park that keeps running to the real reset is not undercounted
--    by this frozen snapshot (calibration-process.md test 5).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claude_usage_hits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claude_account        text NOT NULL,
  tier                  text NOT NULL DEFAULT 'max5',
  kind                  text NOT NULL DEFAULT 'session' CHECK (kind IN ('session', 'weekly')),
  hit_at                timestamptz NOT NULL DEFAULT now(),
  reset_at              timestamptz,
  window_start          timestamptz NOT NULL,
  window_end            timestamptz NOT NULL,
  input_tokens          bigint NOT NULL DEFAULT 0,
  output_tokens         bigint NOT NULL DEFAULT 0,
  cache_read_tokens     bigint NOT NULL DEFAULT 0,
  cache_creation_tokens bigint NOT NULL DEFAULT 0,
  total_cost_usd        numeric(12, 4) NOT NULL DEFAULT 0,
  cost_first_hit        numeric(12, 4) NOT NULL DEFAULT 0,
  runs                  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Idempotent: a second park in the SAME window (a flicker, or a duplicate
  -- runner call) must not add a second row for that exhaustion event.
  UNIQUE (claude_account, kind, window_start)
);

COMMENT ON TABLE claude_usage_hits IS
  'Append-only ground truth of Claude subscription exhaustion events. One row per '
  '(account, kind, window) written by record_claude_usage_hit() at the park moment. '
  'Never updated/deleted. check_claude_usage_limits learns caps from these events.';

CREATE INDEX IF NOT EXISTS idx_claude_usage_hits_tier_kind
  ON claude_usage_hits (tier, kind, window_start);

-- ---------------------------------------------------------------------------
-- 2. record_claude_usage_hit — called by runner.ts at the park moment.
--    Reconstructs the account's current window, snapshots its consumption from
--    claude_runs, and inserts one immutable row (ON CONFLICT DO NOTHING = append-only
--    + idempotent). Returns the new row id, or NULL if the window already had a row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_claude_usage_hit(
  p_account  text,
  p_kind     text DEFAULT 'session',
  p_reset_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_anchor timestamptz;
  v_next   timestamptz;
  v_start  timestamptz;
  v_end    timestamptz;
  v_kind   text := CASE WHEN p_kind = 'weekly' THEN 'weekly' ELSE 'session' END;
  v_id     uuid;
BEGIN
  IF p_account IS NULL OR btrim(p_account) = '' THEN
    RETURN NULL;
  END IF;

  IF v_kind = 'weekly' THEN
    -- Weekly reset is opaque (no fixed-window reconstruction possible). Snapshot the
    -- trailing 7 days ending at the known reset (or now); window_start pins the row.
    v_end   := coalesce(p_reset_at, now());
    v_start := v_end - interval '7 days';
  ELSE
    -- Session: reconstruct the current 5h window's anchor EXACTLY like
    -- check_claude_usage_limits — seed at a real boundary (a request with no request
    -- in the 5h before it), then hop forward +5h until the window contains now().
    SELECT min(cr.created_at) INTO v_anchor
    FROM claude_runs cr
    WHERE cr.claude_account = p_account
      AND cr.created_at > now() - interval '24 hours'
      AND NOT EXISTS (
        SELECT 1 FROM claude_runs pp
        WHERE pp.claude_account = p_account
          AND pp.created_at >= cr.created_at - interval '5 hours'
          AND pp.created_at <  cr.created_at
      );
    IF v_anchor IS NULL THEN
      SELECT min(cr.created_at) INTO v_anchor
      FROM claude_runs cr
      WHERE cr.claude_account = p_account AND cr.created_at > now() - interval '5 hours';
    END IF;
    -- No runs at all (should not happen at a park, but never fail the park on it):
    -- anchor the window at now() so the event is still recorded.
    IF v_anchor IS NULL THEN
      v_anchor := now();
    END IF;
    LOOP
      EXIT WHEN v_anchor + interval '5 hours' > now();
      SELECT min(cr.created_at) INTO v_next
      FROM claude_runs cr
      WHERE cr.claude_account = p_account AND cr.created_at >= v_anchor + interval '5 hours';
      EXIT WHEN v_next IS NULL;
      v_anchor := v_next;
    END LOOP;
    v_start := v_anchor;
    v_end   := v_anchor + interval '5 hours';
  END IF;

  INSERT INTO claude_usage_hits (
    claude_account, tier, kind, reset_at, window_start, window_end,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    total_cost_usd, cost_first_hit, runs
  )
  SELECT
    p_account, 'max5', v_kind, p_reset_at, v_start, v_end,
    coalesce(sum(cr.input_tokens), 0),
    coalesce(sum(cr.output_tokens), 0),
    coalesce(sum(cr.cache_read_tokens), 0),
    coalesce(sum(cr.cache_creation_tokens), 0),
    coalesce(sum(cr.total_cost_usd), 0),
    coalesce(sum(cr.total_cost_usd), 0),
    count(cr.id)::int
  FROM claude_runs cr
  WHERE cr.claude_account = p_account
    AND cr.created_at >= v_start AND cr.created_at < v_end
  ON CONFLICT (claude_account, kind, window_start) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

COMMENT ON FUNCTION public.record_claude_usage_hit(text, text, timestamptz) IS
  'Records one append-only claude_usage_hits row for an account that just hit its '
  'subscription limit (called from runner.ts at the park moment, before the '
  'recoverer erases the usage-limit-wait sign). Idempotent per (account, kind, window).';

-- ---------------------------------------------------------------------------
-- 3. check_claude_usage_limits — same estimator, now with an auto-calibration
--    block at the top that learns the shared session cap from real hit events.
--    Body below is unchanged from migration 20260804200000 except for that block.
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
        WHERE claude_account = '*' AND window_kind = 'session';
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
        WHERE claude_account = '*' AND window_kind = 'weekly';
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

COMMENT ON FUNCTION public.check_claude_usage_limits(boolean) IS
  'Estimates each active Claude account''s consumption in its current 5-hour '
  'window (from claude_runs.total_cost_usd) vs a calibrated cap, and files a '
  'super-admin notification at 70% and 90%. Also self-calibrates the shared ''*'' '
  'session/weekly caps from claude_usage_hits (median full-window cost) once enough '
  'real exhaustion events exist. p_dry_run=true returns status rows without writing.';
