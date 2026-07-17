-- smrtVoice: record which voice produced each take.
--
-- smrtvoice_line_takes had voice_label (set only for multi-voice deliverables)
-- and no voice id at all, so a single-voice take carried NO voice attribution.
-- That made a mixed set of takes (e.g. a re-render on a different voice)
-- impossible to tell apart. Every voice has a Resemble UUID — store it on every
-- take. voice-engine now also sets voice_label on every take (the character
-- name), so the take badge is always populated.

ALTER TABLE smrtvoice_line_takes
  ADD COLUMN IF NOT EXISTS resemble_voice_id text;

COMMENT ON COLUMN smrtvoice_line_takes.resemble_voice_id IS
  'Resemble voice UUID that produced this take (voice attribution / disambiguation).';
