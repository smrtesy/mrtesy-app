-- smrtVoice: let casting mark a speaker as "skip" so generation produces only
-- the speakers the user cast (e.g. to preview a single voice).
ALTER TABLE smrtvoice_script_speakers
  ADD COLUMN IF NOT EXISTS skip boolean NOT NULL DEFAULT false;
