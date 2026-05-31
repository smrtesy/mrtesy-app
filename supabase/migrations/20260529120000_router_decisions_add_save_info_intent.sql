-- Fix: the router (router.ts) classifies and applies a 'save_info' intent —
-- user is sharing a fact/note to store rather than an action to do — but the
-- router_decisions.intent CHECK constraint was never widened to allow it.
-- Result: every save_info classification failed the insert with
-- "new row for relation \"router_decisions\" violates check constraint
--  \"router_decisions_intent_check\"".
--
-- Widen the constraint to include 'save_info' so it matches the Intent union
-- in server/src/modules/smrttask/routes/router.ts.

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
