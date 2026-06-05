-- smrtTask: two-tier task-BUILDER escalation knobs (mirror of the classifier
-- escalation added in 20260605150000). The task builder now self-reports a
-- "confidence" field on every extraction; that level is always recorded in the
-- log. When escalate_task_low_confidence is true and the default builder
-- returns confidence="low", ai-process re-runs the build once on
-- task_escalation_model (Opus by default) and keeps that result. ai-process
-- reads both via loadSystemParams(); without these columns it falls back to the
-- hardcoded defaults (escalation OFF, Opus as the target). Idempotent.

ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS escalate_task_low_confidence boolean NOT NULL DEFAULT false;

ALTER TABLE smrttask_system_params
  ADD COLUMN IF NOT EXISTS task_escalation_model text NOT NULL DEFAULT 'claude-opus-4-8';
