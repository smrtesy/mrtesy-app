-- ============================================================
-- smrtVoice — Per-take approval + note (comp/casting workflow)
-- ============================================================
-- Lets the user mark a ✓ on ANY take (not just the line's current audio) and
-- jot which word they want from it, so the best pieces can be assembled later.

ALTER TABLE smrtvoice_line_takes
  -- "This take is good" — independent per take (multiple may be approved).
  ADD COLUMN IF NOT EXISTS approved boolean NOT NULL DEFAULT false,
  -- Free note, e.g. "use the word 'shalom' from here".
  ADD COLUMN IF NOT EXISTS note text;
