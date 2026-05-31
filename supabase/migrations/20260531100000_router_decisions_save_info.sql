-- Add 'save_info' to the router_decisions.intent CHECK constraint.
--
-- The router classifier (server/src/modules/smrttask/routes/router.ts) and the
-- WhatsApp self-message webhook both emit intent='save_info' to capture a fact
-- the user wants stored (price, phone, note) rather than an action to perform.
-- The original constraint (20260520120000_router_decisions.sql) never listed
-- 'save_info', so every save-info insert was rejected by the CHECK before the
-- user ever saw the preview — silently breaking the whole save-info flow.
--
-- CHECK constraints are enforced for every role, including service_role, so this
-- could not be worked around from the server; the constraint itself had to grow.
--
-- Idempotent: drop the (auto-named) constraint if present, recreate with the
-- full intent set.

ALTER TABLE router_decisions
  DROP CONSTRAINT IF EXISTS router_decisions_intent_check;

ALTER TABLE router_decisions
  ADD CONSTRAINT router_decisions_intent_check CHECK (intent IN (
    'create_task',
    'update_task',
    'add_subtask',
    'add_update',
    'complete_task',
    'dismiss_task',
    'save_info',
    'unknown'
  ));
