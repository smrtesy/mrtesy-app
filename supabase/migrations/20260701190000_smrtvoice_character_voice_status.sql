-- smrtVoice: track a character's clone readiness so the UI can show "training"
-- immediately after a clone is kicked off (Resemble upgrades to Ultra async).
ALTER TABLE smrtvoice_characters
  ADD COLUMN IF NOT EXISTS voice_status text NOT NULL DEFAULT 'none'
  CHECK (voice_status IN ('none', 'training', 'ready'));
