-- smrtTask: kill-switch for per-matter WhatsApp routing (Part A).
-- When false, ai-process falls back to the legacy single-slot thread_memory
-- linking for WhatsApp. Default true (feature on). Idempotent.

ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS whatsapp_matter_routing boolean NOT NULL DEFAULT true;
