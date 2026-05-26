-- ============================================================
-- smrtVoice — Per-org LLM model override
-- ============================================================
-- Adds a per-org setting for the Claude model used during script
-- preprocessing. NULL = use voice-engine's service default (LLM_MODEL env).
-- Editable from /voice/settings.

ALTER TABLE smrtvoice_settings
  ADD COLUMN IF NOT EXISTS default_llm_model text;
