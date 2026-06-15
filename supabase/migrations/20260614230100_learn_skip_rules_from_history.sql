-- AI cost reduction (2/3): learn deterministic skip rules from real history.
--
-- Observation from source_messages: a long tail of senders is classified by
-- the (expensive Sonnet) thread classifier on EVERY message yet has NEVER once
-- produced a task — payment receipts (service@paypal.com), order updates
-- (order-update@amazon.com), CI/monitoring (bugsnag, bitbucket), bank alerts,
-- newsletters, etc. On the steady-state dataset these "always no-task" senders
-- accounted for ~24% of all AI-classified volume. Each is a full classify call
-- that could be gated to ZERO AI cost by a deterministic `from=` skip rule —
-- the exact mechanism preClassify() in ai-process already enforces.
--
-- This migration adds a stats job that mines that history and proposes
-- `from=<sender>` skip rules as PENDING SUGGESTIONS (is_active=false,
-- suggestion_status='pending') — surfaced in the existing rules screen for the
-- user to approve. They are deliberately NOT auto-activated: a blanket
-- sender-skip drops all future mail from that sender before the AI ever sees
-- it, so the human stays in the loop on which senders to silence. Approving
-- them is what realizes the saving; the suggestion itself changes nothing.
--
-- Safety of the candidate criteria (conservative by construction):
--   • total >= 8 AI-classified messages  → enough evidence, not a one-off
--   • task_count = 0                      → never produced an actionable item,
--                                            so it cannot be silencing a sender
--                                            that has ever mattered. Any sender
--                                            with even one task in history (the
--                                            user's own addresses, real
--                                            contacts, banks that did send a
--                                            real ask) is excluded automatically.
--   • only AI-processed rows (skip_reason IS NULL) are counted, so already
--     rule-gated traffic does not inflate the totals.
--   • idempotent: a sender already carrying any `from=` rule (active, pending,
--     OR previously rejected) is skipped, so the job never duplicates a rule
--     and never re-proposes one the user already declined.

CREATE OR REPLACE FUNCTION suggest_skip_rules_from_history()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer := 0;
BEGIN
  WITH sender_stats AS (
    SELECT
      sm.user_id,
      lower(sm.sender_email) AS sender,
      count(*) AS total,
      count(*) FILTER (
        WHERE lower(sm.ai_classification) IN ('actionable', 'actionable_followup')
      ) AS task_count
    FROM source_messages sm
    WHERE sm.skip_reason IS NULL
      AND sm.ai_classification IS NOT NULL
      AND sm.sender_email IS NOT NULL
      AND position('@' IN sm.sender_email) > 1
    GROUP BY sm.user_id, lower(sm.sender_email)
  ),
  candidates AS (
    SELECT user_id, sender, total
    FROM sender_stats
    WHERE total >= 8
      AND task_count = 0
  )
  INSERT INTO rules_memory
    (user_id, trigger, rule_type, action, reason, is_active,
     created_by, suggestion_status, suggestion_confidence, app_slug)
  SELECT
    c.user_id,
    'from=' || c.sender,
    'skip',
    'skip',
    format(
      'סינון אוטומטי שנלמד מההיסטוריה: %s הודעות מ-%s, אף אחת מעולם לא הפכה למשימה. אישור הכלל יחסוך עיבוד AI על שולח זה.',
      c.total, c.sender
    ),
    false,                                            -- is_active: pending, not active
    'system',
    'pending',                                         -- suggestion_status (table default is 'approved' — must be explicit)
    least(0.990, 0.800 + (c.total::numeric / 200.0))::numeric(4,3),
    'smrttask'
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1 FROM rules_memory r
    WHERE r.user_id = c.user_id
      AND lower(r.trigger) = 'from=' || c.sender
  );

  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RAISE NOTICE '[suggest_skip_rules_from_history] proposed % new skip rule(s)', inserted_count;
  RETURN inserted_count;
END;
$$;

-- Backfill now (one-time, on migration apply) + schedule a daily refresh so
-- newly-recurring no-task senders keep getting proposed as evidence builds.
DO $$
BEGIN
  PERFORM suggest_skip_rules_from_history();

  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('learn-skip-rules')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'learn-skip-rules');
    PERFORM cron.schedule(
      'learn-skip-rules',
      '0 4 * * *',                                    -- daily, 04:00 UTC (quiet hour)
      'SELECT suggest_skip_rules_from_history();'
    );
    RAISE NOTICE '[learn-skip-rules] scheduled daily at 04:00 UTC.';
  ELSE
    RAISE NOTICE '[learn-skip-rules] pg_cron not installed — backfill ran, but no daily schedule. Enable pg_cron and re-run to schedule.';
  END IF;
END $$;
