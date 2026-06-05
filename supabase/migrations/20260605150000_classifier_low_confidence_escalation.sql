-- smrtTask: two-tier classification escalation knobs.
-- The cheap classification_model (Haiku) now self-reports a "confidence" field
-- on every classification. When escalate_low_confidence is true and the cheap
-- model returns confidence="low", ai-process re-runs the classification once on
-- escalation_model (a stronger, pricier model — Sonnet by default) and keeps
-- that answer. This keeps the common case cheap while giving genuinely
-- ambiguous messages (spam-vs-real, informational-vs-actionable, content behind
-- a link) a stronger second opinion. ai-process reads both via
-- loadSystemParams(); without these columns it falls back to the hardcoded
-- defaults (escalation OFF, Sonnet as the escalation target). Idempotent.

ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS escalate_low_confidence boolean NOT NULL DEFAULT false;

ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS escalation_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
