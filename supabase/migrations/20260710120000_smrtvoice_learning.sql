-- ============================================================
-- smrtVoice — Recording learning: learn which respelling wins, per voice
-- ============================================================
-- The studio already keeps every render as a take and lets the user ⭐ the
-- good ones. Until now that pick was thrown away. This migration lets us
-- LEARN from it: when the user respells a word and then keeps that take, we
-- record that the respelling worked — scoped to the VOICE that produced it,
-- so different characters (and uploaded vs stock voices) can diverge.
--
-- Scope is deliberately "suggestion only": we record, aggregate and surface.
-- Nothing here auto-applies a respelling — the user always chooses.
--
-- All additive; existing takes/data keep working. Learning accrues from now.

-- ─── 1. Per-take tag-free spoken text ────────────────────────
-- The (original → respelling) diff must compare clean spoken text, not the
-- body with embedded tone tags ([sigh], <whisper>…). The voice-engine worker
-- fills this on every new render (= line.text_for_tts). Old takes stay NULL and
-- the backend falls back to stripping tags out of text_used at read time.
ALTER TABLE smrtvoice_line_takes
  ADD COLUMN IF NOT EXISTS text_spoken text;

-- ─── 2. Pronunciation feedback ───────────────────────────────
-- One row per (take × respelled word). A word only appears when a take's spoken
-- text DIFFERS from the line's original text_clean (i.e. it was respelled).
-- `chosen` mirrors the take's ⭐ approval, resynced whenever approval changes.
-- The voice identity is snapshotted so a later recast of the line never
-- rewrites past history.
CREATE TABLE IF NOT EXISTS smrtvoice_pronunciation_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  take_id           uuid NOT NULL REFERENCES smrtvoice_line_takes(id) ON DELETE CASCADE,
  line_id           uuid NOT NULL REFERENCES smrtvoice_lines(id) ON DELETE CASCADE,

  -- Which voice produced this take (snapshot at capture time).
  character_id      uuid REFERENCES smrtvoice_characters(id) ON DELETE SET NULL,
  resemble_voice_id text,
  model             text,

  -- The learned pair: original word (from text_clean) → respelling synthesized.
  original_word     text NOT NULL,
  pronounced_as     text NOT NULL,

  -- Did the user keep this take (⭐)? The success signal.
  chosen            boolean NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- One row per take × respelled word (the resync target).
  UNIQUE (take_id, original_word, pronounced_as)
);

ALTER TABLE smrtvoice_pronunciation_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtvoice_pronunciation_feedback_org_members"
  ON smrtvoice_pronunciation_feedback;
CREATE POLICY "smrtvoice_pronunciation_feedback_org_members"
  ON smrtvoice_pronunciation_feedback
  FOR ALL
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- "Best respellings for this word on this voice / character".
CREATE INDEX IF NOT EXISTS smrtvoice_pron_feedback_voice_word_idx
  ON smrtvoice_pronunciation_feedback(org_id, resemble_voice_id, original_word);
CREATE INDEX IF NOT EXISTS smrtvoice_pron_feedback_char_word_idx
  ON smrtvoice_pronunciation_feedback(org_id, character_id, original_word);
-- Resync deletes/reinserts by line.
CREATE INDEX IF NOT EXISTS smrtvoice_pron_feedback_line_idx
  ON smrtvoice_pronunciation_feedback(line_id);

DROP TRIGGER IF EXISTS smrtvoice_pron_feedback_updated_at
  ON smrtvoice_pronunciation_feedback;
CREATE TRIGGER smrtvoice_pron_feedback_updated_at
  BEFORE UPDATE ON smrtvoice_pronunciation_feedback
  FOR EACH ROW EXECUTE FUNCTION smrtvoice_update_updated_at();
