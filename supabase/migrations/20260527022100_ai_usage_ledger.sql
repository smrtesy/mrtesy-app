-- Migration: ai_usage — unified AI/LLM cost ledger.
--
-- Single source of truth for EVERY paid AI call across the whole platform:
-- the ai-process / quick-action / project-detection edge functions, the
-- Express server (Anthropic + Gemini wrappers), and the voice-engine
-- (Anthropic preprocessing + Resemble TTS). Each call writes ONE row here so
-- the admin dashboard can show a real per-component and per-provider cost
-- breakdown that reconciles against the Anthropic/Google/Resemble bills.
--
-- Writes come from service-role clients (edge functions, server, voice-engine)
-- which bypass RLS. Reads are limited to platform super-admins.

CREATE TABLE IF NOT EXISTS public.ai_usage (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  user_id            uuid,
  -- 'anthropic' | 'google' | 'resemble'
  provider           text NOT NULL,
  -- coarse part label, e.g. 'ai_process.classify', 'ai_process.task',
  -- 'project_detection', 'quick_action', 'server.action', 'server.router',
  -- 'server.project', 'server.whatsapp', 'gemini.pdf',
  -- 'voice_engine.preprocess', 'resemble.tts'
  component          text NOT NULL,
  model              text,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd           numeric(14,6) NOT NULL DEFAULT 0,
  -- free-form reference: source_message_id / task_id / job_id, for tracing
  ref_id             text
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON public.ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider   ON public.ai_usage (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_component  ON public.ai_usage (component, created_at DESC);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

-- Super-admins (anon client on the admin dashboard) may read the whole ledger.
DROP POLICY IF EXISTS "ai_usage_superadmin_read" ON public.ai_usage;
CREATE POLICY "ai_usage_superadmin_read" ON public.ai_usage
  FOR SELECT USING (auth.uid() IN (SELECT user_id FROM public.super_admins));
