-- smrtTask: WhatsApp burst-coalescing debounce window (seconds).
-- A `whatsapp` source_messages burst row only becomes eligible for
-- classification once its chat has been quiet for this long, so rapid
-- follow-up messages are gathered into ONE classification pass instead of
-- each spawning duplicate work. This is a TIMING knob only — it never decides
-- matter boundaries (the content-based matter router owns that). ai-process
-- reads it via loadSystemParams(); without this column it silently falls back
-- to the hardcoded 90s default. Default 90. Idempotent.

ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS whatsapp_debounce_seconds integer NOT NULL DEFAULT 90;
