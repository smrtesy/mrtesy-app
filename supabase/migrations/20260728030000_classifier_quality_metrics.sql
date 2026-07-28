-- Weekly quality metrics for the message classifier (review §6.4 / fix-list §9).
--
-- WHY THIS EXISTS
-- Until now the only way a classifier problem surfaced was the user noticing a
-- wrong task. Everything needed to see it earlier was already in the database —
-- nobody was looking. The cost of that: for the 30 days to 2026-07-27, 72% of
-- dupe_match calls (993/1380) were being truncated at the max_tokens ceiling and
-- silently discarded, so duplicate detection was mostly broken for a month with
-- no visible signal. One weekly query would have caught it in the first week.
--
-- This function is that query. It reads ONLY existing tables (log_entries,
-- task_corrections, ai_usage) — no new writes anywhere in the pipeline, no AI
-- calls, zero ongoing cost.
--
-- HOW TO READ THE OUTPUT
--   correction_rate_pct   the headline. Share of classified messages the user
--                         had to fix by hand. Baseline at introduction: ~1.1%
--                         (68 corrections over June+July / ~3k classifications).
--                         Every prompt or model change is judged against it.
--   low_confidence_pct    the classifier's own self-doubt. A jump means the
--                         inputs got harder OR a prompt change confused it.
--   parse_failures        replies the code could not parse. Should be ~0. Any
--                         sustained non-zero is a silent-loss bug like the
--                         dupe_match one above.
--   cross_party_flags     the T1804 invariant (check_cross_party_merges). Any
--                         non-zero means the identity veto regressed.
--   escalations           how often the sensitive-wording / low-confidence path
--                         spent a second model call. Watch when a Sonnet 5
--                         pilot puts a DIFFERENT model behind escalation_model
--                         (until then the guard makes it a no-op).
--   cost_per_message_usd  the number to compare across model changes. Compare
--                         THIS, never token counts — Sonnet 5's tokenizer
--                         counts ~30% higher for identical text.
--   cache_read_share_pct  share of prompt tokens served from cache. The classify
--                         prefix is ~5k tokens on a 1h TTL, so a healthy figure
--                         is high; a sudden drop means something volatile leaked
--                         into the cached prefix.
--
-- SECURITY: SECURITY INVOKER (the default), exactly like ai_usage_summary().
-- log_entries / task_corrections / ai_usage are RLS-protected, so an ordinary
-- authenticated caller aggregates over their own rows only, and the admin page
-- (service-role) sees the platform. An admin-rights function here would leak
-- every tenant's volumes to any logged-in user.

CREATE OR REPLACE FUNCTION public.classifier_quality_metrics(
  p_weeks   integer DEFAULT 8,
  p_user_id uuid    DEFAULT NULL
)
RETURNS TABLE (
  week_start           date,
  classified_messages  bigint,
  ai_calls             bigint,
  corrections          bigint,
  correction_rate_pct  numeric,
  low_confidence_pct   numeric,
  escalations          bigint,
  parse_failures       bigint,
  cross_party_flags    bigint,
  cost_usd             numeric,
  cost_per_message_usd numeric,
  cache_read_share_pct numeric
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    -- Weeks are ISO (Monday-start) and the current partial week is included:
    -- a regression should be visible the week it lands, not next Monday.
    SELECT date_trunc('week', now())::date - ((GREATEST(p_weeks, 1) - 1) * 7) AS first_week
  ),
  weeks AS (
    SELECT generate_series((SELECT first_week FROM bounds),
                           date_trunc('week', now())::date,
                           interval '7 days')::date AS week_start
  ),
  -- One row per message the pipeline actually classified with AI. skip /
  -- informational early-exits never reach a model, so counting them would
  -- deflate every rate below by however much noise the filters caught.
  classified AS (
    SELECT date_trunc('week', l.created_at)::date AS week_start,
           count(*) AS n,
           count(*) FILTER (
             WHERE lower(COALESCE(l.details->>'classification_confidence', '')) = 'low'
           ) AS low_conf,
           count(*) FILTER (WHERE l.details ? 'classification_trail') AS escalated
    FROM public.log_entries l
    WHERE l.category = 'ai_process'
      AND l.status = 'ok'
      AND l.ai_model_used IS NOT NULL
      AND l.created_at >= (SELECT first_week FROM bounds)
      AND (p_user_id IS NULL OR l.user_id = p_user_id)
    GROUP BY 1
  ),
  -- Bucketed by the week the MESSAGE was classified, not the week the user got
  -- around to fixing it. Bucketing by correction date compares this week's
  -- corrections against this week's volume even when the correction is about a
  -- message from three weeks ago — which can push the rate above 100% and makes
  -- a bad week look fine as long as the user is slow to complain. The cost of
  -- the cohort form is a lag: the most recent week's rate only firms up as
  -- corrections arrive, so read the newest row as provisional.
  corrections AS (
    SELECT date_trunc('week', COALESCE(m.processed_at, m.received_at))::date AS week_start,
           count(*) AS n
    FROM public.task_corrections c
    JOIN public.source_messages m ON m.id = c.source_message_id
    WHERE c.app_slug = 'smrttask'
      AND COALESCE(m.processed_at, m.received_at) >= (SELECT first_week FROM bounds)
      AND (p_user_id IS NULL OR c.user_id = p_user_id)
    GROUP BY 1
  ),
  -- Silent-loss signals. dupe_match logs its own unparseable replies (added
  -- 2026-07-27); the generic ai_process failures cover the classify pass.
  failures AS (
    SELECT date_trunc('week', l.created_at)::date AS week_start,
           count(*) FILTER (WHERE l.category = 'ai_process_dupe_match') AS parse_failures,
           count(*) FILTER (WHERE l.category = 'dupe_cross_party')      AS cross_party
    FROM public.log_entries l
    WHERE l.category IN ('ai_process_dupe_match', 'dupe_cross_party')
      AND l.level IN ('warning', 'error')
      AND l.created_at >= (SELECT first_week FROM bounds)
      AND (p_user_id IS NULL OR l.user_id = p_user_id)
    GROUP BY 1
  ),
  -- Cost comes from the ai_usage ledger, not log_entries: the ledger has one
  -- row per paid call including the escalation second pass, and it is the same
  -- source /admin/usage bills against.
  spend AS (
    SELECT date_trunc('week', u.created_at)::date AS week_start,
           count(*)                            AS calls,
           COALESCE(sum(u.cost_usd), 0)        AS cost_usd,
           COALESCE(sum(u.input_tokens), 0)    AS input_tokens,
           COALESCE(sum(u.cache_read_tokens), 0)  AS cache_read_tokens,
           COALESCE(sum(u.cache_write_tokens), 0) AS cache_write_tokens
    FROM public.ai_usage u
    WHERE u.component LIKE 'ai_process.%'
      AND u.created_at >= (SELECT first_week FROM bounds)
      AND (p_user_id IS NULL OR u.user_id = p_user_id)
    GROUP BY 1
  )
  SELECT
    w.week_start,
    COALESCE(cl.n, 0)                                   AS classified_messages,
    COALESCE(sp.calls, 0)                               AS ai_calls,
    COALESCE(co.n, 0)                                   AS corrections,
    -- NULLIF everywhere: a week with no classifications shows NULL ("no data"),
    -- never a 0% that reads like perfect quality.
    round(100.0 * COALESCE(co.n, 0) / NULLIF(cl.n, 0), 2)       AS correction_rate_pct,
    round(100.0 * COALESCE(cl.low_conf, 0) / NULLIF(cl.n, 0), 2) AS low_confidence_pct,
    COALESCE(cl.escalated, 0)                           AS escalations,
    COALESCE(f.parse_failures, 0)                       AS parse_failures,
    COALESCE(f.cross_party, 0)                          AS cross_party_flags,
    round(COALESCE(sp.cost_usd, 0), 4)                  AS cost_usd,
    round(COALESCE(sp.cost_usd, 0) / NULLIF(cl.n, 0), 5) AS cost_per_message_usd,
    round(100.0 * COALESCE(sp.cache_read_tokens, 0)
          / NULLIF(COALESCE(sp.input_tokens, 0) + COALESCE(sp.cache_read_tokens, 0)
                   + COALESCE(sp.cache_write_tokens, 0), 0), 1) AS cache_read_share_pct
  FROM weeks w
  LEFT JOIN classified  cl ON cl.week_start = w.week_start
  LEFT JOIN corrections co ON co.week_start = w.week_start
  LEFT JOIN failures    f  ON f.week_start  = w.week_start
  LEFT JOIN spend       sp ON sp.week_start = w.week_start
  ORDER BY w.week_start DESC;
$$;

COMMENT ON FUNCTION public.classifier_quality_metrics(integer, uuid) IS
  'Weekly classifier quality + cost trend from existing tables (no AI calls). See docs/classifier-review-2026-07.md §6.4.';

-- Same grant shape as ai_usage_summary(): no reason for `anon` to hold EXECUTE
-- on a platform-metrics function, even an invoker-rights one.
REVOKE ALL ON FUNCTION public.classifier_quality_metrics(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.classifier_quality_metrics(integer, uuid) TO authenticated, service_role;

-- The three window scans this function runs every time the admin page loads.
-- log_entries is the big one (~10k rows/30d and growing); without these the
-- page degrades into three sequential seq-scans as history accumulates.
CREATE INDEX IF NOT EXISTS log_entries_category_created_at_idx
  ON public.log_entries (category, created_at DESC);
CREATE INDEX IF NOT EXISTS task_corrections_app_created_at_idx
  ON public.task_corrections (app_slug, created_at DESC);
