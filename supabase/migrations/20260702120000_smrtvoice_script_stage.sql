-- smrtVoice: per-stage generation progress on the script row.
--
-- The generation pipeline has several long phases before any audio appears
-- (fetch Google Doc → parse → LLM-preprocess every line → synthesize every
-- line). Progress used to be reported only via per-line webhooks, which (a)
-- fire only during the audio phase and (b) never arrive if the webhook URL is
-- misconfigured — so the UI sat on "starting soon" for minutes.
--
-- The worker now writes these fields DIRECTLY (service-role, keyed by
-- script_id) at every phase, so the script-detail screen can show a live
-- stepper without depending on webhooks at all.
--
-- Additive + nullable → safe to apply with rows present.

ALTER TABLE smrtvoice_scripts
  ADD COLUMN IF NOT EXISTS stage text,
  ADD COLUMN IF NOT EXISTS stage_current integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage_total integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN smrtvoice_scripts.stage IS
  'Current generation phase: fetching | parsing | preprocessing | generating | finalizing. NULL when idle.';
COMMENT ON COLUMN smrtvoice_scripts.stage_current IS
  'Items done within the current stage (e.g. lines preprocessed / lines synthesized).';
COMMENT ON COLUMN smrtvoice_scripts.stage_total IS
  'Total items in the current stage.';
