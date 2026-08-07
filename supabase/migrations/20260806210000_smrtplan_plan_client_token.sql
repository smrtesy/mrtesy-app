-- Idempotent plan creation for smrtPlan.
--
-- The bug this fixes: POST /plans is not idempotent, so the client
-- (src/lib/api/client.ts) never retries it. When the Railway backend is
-- momentarily busy or mid-redeploy, the browser's fetch throws
-- "TypeError: Failed to fetch" before/instead of a response — the PlanEditDialog
-- surfaces a toast and the plan is not created. The user re-clicks "Add" and, if
-- a naive retry were enabled, would create a DUPLICATE plan.
--
-- The fix: the client sends a stable client_token (a UUID) per create and may now
-- retry the POST safely. This column + partial unique index let the server
-- recognize a retried create and return the SAME plan instead of inserting a
-- second one. Scoped per org; NULL tokens (any legacy/other caller) are ignored
-- by the partial index, so nothing existing is constrained.
--
-- Mirrors the Claude-console fix in migration 20260805150000.
-- Additive and reversible — a new nullable column and a partial unique index.

ALTER TABLE smrtplan_plans
  ADD COLUMN IF NOT EXISTS client_token uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_smrtplan_plans_org_client_token
  ON smrtplan_plans (org_id, client_token) WHERE client_token IS NOT NULL;

COMMENT ON COLUMN smrtplan_plans.client_token IS
  'Client-generated idempotency key for a plan create. A retried POST carrying '
  'the same (org_id, client_token) returns the existing plan instead of creating '
  'a duplicate. See supabase/migrations/20260806210000.';
