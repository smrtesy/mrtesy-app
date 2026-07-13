-- ============================================================
-- smrtVoice — Learning: also learn punctuation, not just spelling
-- ============================================================
-- The learning system records (original word → respelling) pairs kept on a
-- starred take. Until now every pair was treated the same. The user wants a
-- PRECISE picture of what works best — including whether adding a comma, a
-- period, or other punctuation to a word is what made a take sound right.
--
-- This adds a `kind` classifier to each feedback row:
--   • 'punctuation' — the original and the respelling are the SAME word once
--     punctuation is stripped (e.g. "שלום" → "שלום,"): only punctuation changed.
--   • 'spelling'    — the letters themselves changed (e.g. "770" → "סעוון").
-- The backend classifies each pair at capture time; the insights screen groups
-- learnings by this kind so the user sees spelling vs punctuation separately.
--
-- Additive; existing rows default to 'spelling' (their historical meaning).

ALTER TABLE smrtvoice_pronunciation_feedback
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'spelling'
    CHECK (kind IN ('spelling', 'punctuation'));
