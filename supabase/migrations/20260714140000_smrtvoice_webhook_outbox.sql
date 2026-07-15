-- Durable webhook outbox + exactly-once notification guard for smrtVoice.
--
-- Root cause of the BR1/NM1/NM2 "stuck in processing" incident: the
-- voice-engine's callback URL (built from a stale SMRTESY_PUBLIC_URL) pointed
-- at a dead Railway host, so EVERY webhook — job.started, line.completed,
-- job.completed — returned Railway's edge 404 ("Application not found"). The
-- engine retried 5 times in-process then gave up permanently (no durable
-- retry), and its own direct write of the job's running/terminal status was
-- keyed on the wrong column, so the job row never left 'queued'.
--
-- The engine-side fix (voice-engine repo) is two-fold:
--   1. Direct job-status writes now key on voice_engine_job_id (the column
--      smrtesy actually stores our id in) — so running/terminal status lands
--      even when the webhook never does.
--   2. Lifecycle webhooks are persisted to THIS outbox before delivery and a
--      per-minute drain re-delivers until smrtesy acks — so the moment the URL
--      is corrected, every stranded job.completed/job.failed flows through.
--
-- This migration provisions the table the engine writes to, plus a
-- notified-once marker on smrtvoice_jobs so the (now reliably-redelivered,
-- hence possibly-duplicated) job.completed / job.failed webhook fires the
-- user notification + event exactly once, regardless of whether the direct
-- write or the webhook set the terminal status first.

-- 1) Exactly-once guard. The direct engine write sets status; the webhook
--    handler owns the user-facing notify/emitEvent and stamps this column so a
--    redelivered webhook is a no-op for side effects.
ALTER TABLE public.smrtvoice_jobs
  ADD COLUMN IF NOT EXISTS terminal_notified_at timestamptz;

-- 2) The durable outbox. Written by the voice-engine worker via the service
--    role; never touched by end users.
CREATE TABLE IF NOT EXISTS public.smrtvoice_webhook_outbox (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type           text NOT NULL,
  voice_engine_job_id  uuid,
  org_id               uuid,
  project_id           uuid,
  -- EXACT bytes signed + POSTed. Stored as TEXT on purpose: re-delivery
  -- re-signs these same bytes with a fresh timestamp, so smrtesy's HMAC still
  -- matches. Storing as jsonb would re-serialize and break the signature.
  payload              text NOT NULL,
  callback_url         text NOT NULL,
  callback_secret      text NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','delivered','giving_up')),
  attempts             int  NOT NULL DEFAULT 0,
  last_error           text,
  next_attempt_at      timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz
);

-- Drain query hot path: pending rows whose next_attempt_at has passed.
CREATE INDEX IF NOT EXISTS smrtvoice_webhook_outbox_due_idx
  ON public.smrtvoice_webhook_outbox (next_attempt_at)
  WHERE status = 'pending';

-- Service-role only. Enable RLS with no policies so anon/authenticated cannot
-- read the stored callback_secret; the service role bypasses RLS.
ALTER TABLE public.smrtvoice_webhook_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.smrtvoice_webhook_outbox FROM anon, authenticated;
