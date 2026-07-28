-- The classifier golden set (review §6.2 / fix-list §8): a labelled corpus of
-- REAL messages that every prompt or model change must be measured against.
--
-- WHY
-- Today "did that prompt change help?" is answered by feeling, and confirmed
-- only weeks later by the user hand-fixing tasks. The corpus turns work the
-- user already did — 14 explicit reclassifications, 1,015 approved tasks, 140
-- dismissals — into a fixed exam. The most valuable property is REGRESSION
-- COVER: a mistake the user corrected once must never be made again silently,
-- and after this it cannot be, because the next model runs against it.
--
-- It is also the gate for the Sonnet 5 decision. Without it that migration is a
-- guess; with it, it is a measurement.
--
-- LABELS COME FROM RECORDED USER ACTIONS, NEVER FROM A MODEL.
-- This table is only worth something if its labels are ground truth, so every
-- label traces to something the user DID, and anything ambiguous is stored
-- unlabelled for human review rather than guessed:
--
--   reclassify correction  → the user said outright "this classification was
--                            wrong, it is X". Highest-value rows: these are the
--                            documented failures.
--   manually_verified task → the user approved the task, so the message was
--                            genuinely ACTIONABLE.
--   dismissal, but ONLY the two sender-based codes → the user said this sender
--                            should not have produced a task at all, i.e. not
--                            actionable.
--   note correction        → free text with no label. Stored with
--                            expected_classification NULL / needs_review, so a
--                            human can label it. NOT guessed.
--
-- DELIBERATELY EXCLUDED, and this is the crux: `auto_resolved`, `duplicate` and
-- `reply_received` dismissals. Those are LIFECYCLE outcomes — the matter closed
-- itself, another card covered it, the other side replied — and say nothing
-- about whether classifying the message as actionable was right. Feeding them
-- in as "should have been informational" would teach the corpus that every
-- resolved task was a mistake, and a model tuned against it would start
-- dropping real tasks. `custom` is free text and equally unusable as a label.

CREATE TABLE IF NOT EXISTS public.classifier_golden_set (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL,
  source_message_id       uuid NOT NULL REFERENCES public.source_messages(id) ON DELETE CASCADE,

  -- The verdict the classifier SHOULD return. NULL = not labelled yet
  -- (review_status='needs_review'); an eval must skip those, never treat NULL
  -- as informational.
  expected_classification text CHECK (expected_classification IN ('actionable', 'informational', 'spam')),
  review_status           text NOT NULL DEFAULT 'confirmed'
                            CHECK (review_status IN ('confirmed', 'needs_review', 'rejected')),

  -- Where the label came from, so a disputed row can be traced back to the
  -- action that produced it.
  origin                  text NOT NULL
                            CHECK (origin IN ('reclassify_correction', 'note_correction',
                                              'verified_task', 'dismissed_sender', 'manual')),
  origin_ref              uuid,
  note                    text,

  -- Denormalised for readability and for stratified sampling without a join.
  -- The BODY stays in source_messages — the eval replays through the real
  -- classifier, which reads it there, and copying bodies would duplicate
  -- personal data for no gain.
  source_type             text,
  sender_email            text,
  subject                 text,
  message_received_at     timestamptz,

  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- One row per message: a message that was both corrected and approved is one
  -- exam question, not two. Precedence is handled in the seeder below.
  UNIQUE (user_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS classifier_golden_set_active_idx
  ON public.classifier_golden_set (is_active, review_status);
CREATE INDEX IF NOT EXISTS classifier_golden_set_user_idx
  ON public.classifier_golden_set (user_id);

ALTER TABLE public.classifier_golden_set ENABLE ROW LEVEL SECURITY;

-- Owner-only, matching every other per-user table here. The eval harness runs
-- as service-role and bypasses RLS, exactly like shadow_eval_results.
DROP POLICY IF EXISTS classifier_golden_set_owner ON public.classifier_golden_set;
CREATE POLICY classifier_golden_set_owner ON public.classifier_golden_set
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.classifier_golden_set IS
  'Labelled corpus of real messages for classifier evaluation. Labels derive from recorded user actions only — see docs/classifier-review-2026-07.md §6.2.';

-- ── Seeder ────────────────────────────────────────────────────────────────
-- Idempotent and re-runnable: new corrections/approvals join the corpus on the
-- next run, and a row a human has already labelled is never overwritten.
--
-- Insert order IS the precedence order — reclassification > approval > sender
-- dismissal > unlabelled note. The unlabelled note goes LAST on purpose: it
-- carries no label, so inserting it first would let a placeholder squat on a
-- message that one of the labelled sources could have answered.
--
-- Only block 1 (an explicit reclassification — the user stating the correct
-- answer outright) may UPGRADE an existing placeholder, and only while that row
-- is still an untouched `needs_review` with no label. Every other block is
-- DO NOTHING. Without that upgrade, a note filed before a reclassification
-- would freeze the row forever and silently discard the most valuable label in
-- the whole corpus.
CREATE OR REPLACE FUNCTION public.seed_classifier_golden_set(
  p_target_verified integer DEFAULT 120,
  p_since           timestamptz DEFAULT now() - interval '180 days'
)
RETURNS TABLE (origin text, inserted bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_counts jsonb := '{}'::jsonb;
  v_n      bigint;
BEGIN
  -- 1. Reclassifications — the documented failures. The log UI stores
  -- pipeline-internal labels ('user_actionable', '*_followup'); normalise them
  -- to real categories with the SAME transform ai-process applies (asCategory),
  -- or the corpus would carry labels the classifier can never emit.
  WITH src AS (
    SELECT DISTINCT ON (c.user_id, c.source_message_id)
           c.user_id,
           c.source_message_id,
           regexp_replace(regexp_replace(lower(c.new_value), '^user_', ''), '_followup$', '') AS cls,
           c.id   AS origin_ref,
           c.note
    FROM public.task_corrections c
    WHERE c.correction_type = 'reclassify'
      AND c.app_slug = 'smrttask'
      AND c.source_message_id IS NOT NULL
      AND c.new_value IS NOT NULL
      AND c.created_at >= p_since
    ORDER BY c.user_id, c.source_message_id, c.created_at DESC
  )
  INSERT INTO public.classifier_golden_set (
    user_id, source_message_id, expected_classification, review_status, origin, origin_ref, note,
    source_type, sender_email, subject, message_received_at)
  SELECT s.user_id, s.source_message_id, s.cls, 'confirmed', 'reclassify_correction', s.origin_ref, s.note,
         m.source_type, m.sender_email, m.subject, m.received_at
  FROM src s
  JOIN public.source_messages m ON m.id = s.source_message_id
  WHERE s.cls IN ('actionable', 'informational', 'spam')
  ON CONFLICT (user_id, source_message_id) DO UPDATE
    SET expected_classification = EXCLUDED.expected_classification,
        review_status           = EXCLUDED.review_status,
        origin                  = EXCLUDED.origin,
        origin_ref              = EXCLUDED.origin_ref,
        note                    = EXCLUDED.note,
        updated_at              = now()
    -- Upgrades an unlabelled placeholder ONLY. A row a human has labelled,
    -- confirmed or rejected is never touched by the seeder again.
    WHERE classifier_golden_set.expected_classification IS NULL
      AND classifier_golden_set.review_status = 'needs_review';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('reclassify_correction', v_n);

  -- 3. Sender-based dismissals → not actionable. Only the two codes that mean
  -- "this sender should never have produced a task"; see the header for why the
  -- lifecycle codes are excluded.
  WITH src AS (
    SELECT DISTINCT ON (t.user_id, t.source_message_id)
           t.user_id, t.source_message_id, t.id AS origin_ref,
           COALESCE(t.dismissal_reason_text, t.dismissal_reason_code) AS note
    FROM public.tasks t
    WHERE t.status = 'dismissed'
      AND t.source_message_id IS NOT NULL
      AND t.dismissal_reason_code IN ('sender_unimportant', 'sender_type_unimportant')
      AND t.created_at >= p_since
    ORDER BY t.user_id, t.source_message_id, t.created_at DESC
  )
  INSERT INTO public.classifier_golden_set (
    user_id, source_message_id, expected_classification, review_status, origin, origin_ref, note,
    source_type, sender_email, subject, message_received_at)
  SELECT s.user_id, s.source_message_id, 'informational', 'confirmed', 'dismissed_sender', s.origin_ref, s.note,
         m.source_type, m.sender_email, m.subject, m.received_at
  FROM src s
  JOIN public.source_messages m ON m.id = s.source_message_id
  ON CONFLICT (user_id, source_message_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('dismissed_sender', v_n);

  -- 2. Approved tasks → actionable. There are ~1,000 of these, far more than a
  -- corpus needs, and taking the newest N would skew to whatever the user
  -- happened to work on last month. Sample STRATIFIED BY source_type so
  -- WhatsApp, email, calendar and Drive are all represented — a corpus that is
  -- 90% Gmail would bless a model that has quietly regressed on WhatsApp.
  WITH ranked AS (
    SELECT DISTINCT ON (t.user_id, t.source_message_id)
           t.user_id, t.source_message_id, t.id AS origin_ref, m.source_type,
           m.sender_email, m.subject, m.received_at
    FROM public.tasks t
    JOIN public.source_messages m ON m.id = t.source_message_id
    WHERE t.manually_verified = true
      AND t.source_message_id IS NOT NULL
      AND t.created_at >= p_since
    ORDER BY t.user_id, t.source_message_id, t.created_at DESC
  ),
  -- PER USER, not globally. A global quota would let the busiest tenant consume
  -- the whole per-source_type allowance and leave every other tenant with zero
  -- verified rows — the quiet failure mode of a shared corpus.
  strata AS (
    SELECT user_id, count(DISTINCT source_type) AS n FROM ranked GROUP BY user_id
  ),
  picked AS (
    SELECT r.*
    FROM (
      SELECT ranked.*,
             row_number() OVER (PARTITION BY user_id, source_type ORDER BY received_at DESC) AS rn
      FROM ranked
    ) r
    JOIN strata st ON st.user_id = r.user_id
    -- Even split across the source types that user actually has, at least 5
    -- each so a low-volume channel still contributes something testable.
    WHERE r.rn <= GREATEST(5, p_target_verified / GREATEST(st.n, 1))
  )
  INSERT INTO public.classifier_golden_set (
    user_id, source_message_id, expected_classification, review_status, origin, origin_ref, note,
    source_type, sender_email, subject, message_received_at)
  SELECT p.user_id, p.source_message_id, 'actionable', 'confirmed', 'verified_task', p.origin_ref,
         'user approved this task', p.source_type, p.sender_email, p.subject, p.received_at
  FROM picked p
  ON CONFLICT (user_id, source_message_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('verified_task', v_n);

  -- 4. Free-text notes — kept as UNLABELLED hard cases. These are messages the
  -- user complained about, so they are exactly the interesting ones; inferring
  -- a label from the prose would be a model guessing ground truth, which is the
  -- one thing this table must not contain.
  WITH src AS (
    SELECT DISTINCT ON (c.user_id, c.source_message_id)
           c.user_id, c.source_message_id, c.id AS origin_ref, c.note
    FROM public.task_corrections c
    WHERE c.correction_type = 'note'
      AND c.app_slug = 'smrttask'
      AND c.source_message_id IS NOT NULL
      AND c.created_at >= p_since
    ORDER BY c.user_id, c.source_message_id, c.created_at DESC
  )
  INSERT INTO public.classifier_golden_set (
    user_id, source_message_id, expected_classification, review_status, origin, origin_ref, note,
    source_type, sender_email, subject, message_received_at)
  SELECT s.user_id, s.source_message_id, NULL, 'needs_review', 'note_correction', s.origin_ref, s.note,
         m.source_type, m.sender_email, m.subject, m.received_at
  FROM src s
  JOIN public.source_messages m ON m.id = s.source_message_id
  ON CONFLICT (user_id, source_message_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_counts := v_counts || jsonb_build_object('note_correction', v_n);

  RETURN QUERY SELECT k, (v_counts->>k)::bigint FROM jsonb_object_keys(v_counts) AS k;
END;
$$;

COMMENT ON FUNCTION public.seed_classifier_golden_set(integer, timestamptz) IS
  'Idempotently (re)builds the classifier golden set from recorded user actions. Safe to re-run; never overwrites a human-edited row.';

-- SECURITY DEFINER + the default PUBLIC EXECUTE would let ANY authenticated
-- user trigger a write across every tenant's rows. The function needs definer
-- rights to read tasks/corrections across users when the admin seeds the
-- corpus, so the grant is what must be locked down, not the rights.
REVOKE ALL ON FUNCTION public.seed_classifier_golden_set(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_classifier_golden_set(integer, timestamptz) TO service_role;

-- Convenience view for the eval harness: only rows with a usable label.
-- security_invoker is mandatory: without it the view runs with the OWNER's
-- rights and quietly bypasses the RLS policy defined above, exposing every
-- tenant's sender_email / subject / note to any authenticated caller.
CREATE OR REPLACE VIEW public.classifier_golden_set_active
  WITH (security_invoker = true) AS
  SELECT * FROM public.classifier_golden_set
  WHERE is_active AND review_status = 'confirmed' AND expected_classification IS NOT NULL;
