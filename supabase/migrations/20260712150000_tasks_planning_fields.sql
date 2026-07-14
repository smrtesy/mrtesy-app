-- Planning fields on tasks (docs/smrtplan-focus-integration.md §2 "migration 3",
-- docs/project-planning-protocol.md §13). These are filled by the AI plan-builder
-- (and the Claude-Code import path), shown on the plan task, and drive decision
-- propagation (§10). Every field is additive and nullable/defaulted, so existing
-- tasks are unaffected.
--
--   definition_of_done   — the "stranger test": the objective done criterion.
--   ai_tier              — how this task gets done: full (🤖 AI does it),
--                          assist (🤝 AI drafts, human approves), human (👤).
--   ai_prompt            — a ready-to-run opening prompt for the AI tiers.
--   is_decision          — a decision task whose outcome flows to dependents.
--   affected_by          — decision task ids whose outcome updates this task
--                          (resolved from the builder's `key` refs → uuid).
--   external_wait_days   — background waits that DON'T burn focus sessions
--                          (renders/queues/vendors); the projection shows these
--                          separately (§4), never folded into the focus date.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS definition_of_done text,
  ADD COLUMN IF NOT EXISTS ai_tier text CHECK (ai_tier IN ('full', 'assist', 'human')),
  ADD COLUMN IF NOT EXISTS ai_prompt text,
  ADD COLUMN IF NOT EXISTS is_decision boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS affected_by uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS external_wait_days integer NOT NULL DEFAULT 0
    CHECK (external_wait_days >= 0);

COMMENT ON COLUMN tasks.definition_of_done IS
  'The "stranger test" — the objective done criterion for the task (planning protocol §13).';
COMMENT ON COLUMN tasks.ai_tier IS
  'full (🤖) | assist (🤝) | human (👤) — how the task gets executed. Distinct from the desk size tier.';
COMMENT ON COLUMN tasks.ai_prompt IS
  'Ready-to-run opening prompt for the AI tiers (planning protocol §13).';
COMMENT ON COLUMN tasks.is_decision IS
  'Decision task: on completion its outcome propagates to tasks listing it in affected_by (§10).';
COMMENT ON COLUMN tasks.affected_by IS
  'Decision task ids whose outcome updates this task (resolved from builder key refs).';
COMMENT ON COLUMN tasks.external_wait_days IS
  'Background wait days that do not burn focus sessions (renders/queues/vendors); shown separately in the projection.';
