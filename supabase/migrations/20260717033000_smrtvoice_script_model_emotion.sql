-- smrtVoice: per-script model override + emotion toggle.
--
-- The model chosen in Settings (smrtvoice_settings.default_resemble_model) is
-- the default for every script. These two columns let a single script override
-- it without touching the global setting:
--   resemble_model  — NULL = inherit the org default; else this model wins for
--                     the whole script (resemble-ultra | chatterbox | chatterbox-turbo).
--   emotion_enabled — NULL = auto (Chatterbox off / ultra on); true/false forces it.
-- Both default NULL so existing scripts keep inheriting (no behavior change).

ALTER TABLE smrtvoice_scripts
  ADD COLUMN IF NOT EXISTS resemble_model text,
  ADD COLUMN IF NOT EXISTS emotion_enabled boolean;

COMMENT ON COLUMN smrtvoice_scripts.resemble_model IS
  'Per-script model override; NULL inherits smrtvoice_settings.default_resemble_model.';
COMMENT ON COLUMN smrtvoice_scripts.emotion_enabled IS
  'Per-script emotion toggle; NULL = auto (off for Chatterbox, on for resemble-ultra).';
