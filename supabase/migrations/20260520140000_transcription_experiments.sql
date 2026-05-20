-- Transcription A/B experiment table.
--
-- Each row captures one voice/audio message that was transcribed by TWO
-- competing Gemini configurations (typically Flash @ high thinking vs
-- Pro @ medium thinking) so the user can review them side-by-side and
-- record a verdict. The "production" transcript that's actually shown
-- in the WhatsApp view continues to be whatever GEMINI_MODEL points to
-- and is stored on whatsapp_messages.body_text as before — this table
-- is purely for evaluation.
--
-- Rows are produced by:
--   1. The webhook (when TRANSCRIPTION_EXPERIMENT_ENABLED=true), for new
--      audio messages as they arrive.
--   2. The backfill endpoint, which replays the last N days of audio
--      messages that don't already have an experiment row.
--
-- After the experiment ends the user flips the app_secret flag back off
-- and (optionally) keeps this table around as a historical baseline.

CREATE TABLE IF NOT EXISTS transcription_experiments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Pointer to the source message (whatsapp_messages is the canonical
  -- audio source today; widen to other tables if/when we transcribe
  -- voice from elsewhere).
  whatsapp_message_id uuid REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  wamid               text NOT NULL,
  chat_id             text,
  audio_received_at   timestamptz,
  audio_mime          text,

  -- Arm A
  model_a         text NOT NULL,
  thinking_a      text,
  transcript_a    text,
  cost_a_usd      numeric(10,6),
  latency_a_ms    integer,
  error_a         text,

  -- Arm B
  model_b         text NOT NULL,
  thinking_b      text,
  transcript_b    text,
  cost_b_usd      numeric(10,6),
  latency_b_ms    integer,
  error_b         text,

  -- Verdict, recorded by the user via the review UI
  verdict         text CHECK (verdict IN ('a','b','tie','skip')),
  verdict_note    text,
  verdict_at      timestamptz,

  -- Provenance: which path produced this row
  source          text NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook','backfill')),

  created_at      timestamptz NOT NULL DEFAULT now(),

  -- One experiment row per (user, message). Re-runs replace.
  UNIQUE (user_id, wamid)
);

CREATE INDEX IF NOT EXISTS idx_transcription_experiments_user_pending
  ON transcription_experiments(user_id, created_at DESC)
  WHERE verdict IS NULL;

CREATE INDEX IF NOT EXISTS idx_transcription_experiments_user_verdict
  ON transcription_experiments(user_id, verdict, created_at DESC);

ALTER TABLE transcription_experiments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transcription_experiments_self_select ON transcription_experiments;
CREATE POLICY transcription_experiments_self_select
  ON transcription_experiments FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS transcription_experiments_self_update ON transcription_experiments;
CREATE POLICY transcription_experiments_self_update
  ON transcription_experiments FOR UPDATE
  USING (user_id = auth.uid());
