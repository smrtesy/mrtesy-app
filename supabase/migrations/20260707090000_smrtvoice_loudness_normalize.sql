-- ============================================================
-- smrtVoice — Loudness normalization + enable post-processing
-- ============================================================
-- Even out volume: a per-clip loudness target so lines don't jump in level
-- relative to each other, plus the (already-existing) gentle compressor that
-- tames swings within a line. Both ride under the master postprocess toggle.

ALTER TABLE smrtvoice_settings
  -- Normalize every clip to the same target loudness (RMS dBFS).
  ADD COLUMN IF NOT EXISTS postprocess_normalize boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS postprocess_target_db  numeric NOT NULL DEFAULT -20
    CHECK (postprocess_target_db BETWEEN -40 AND -6);

-- Turn the volume treatment ON (master + compressor + normalize). Future
-- renders only — existing clips are left untouched. Users can flip the master
-- toggle off in Voice settings before a run if a particular one comes out bad.
UPDATE smrtvoice_settings
   SET postprocess_enabled  = true,
       postprocess_compress = true,
       postprocess_normalize = true;
