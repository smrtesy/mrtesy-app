-- claude_deploy_queue.conflict_attempts — how many times the coordinator has handed
-- a merge conflict on this row back to its session for autonomous resolution.
--
-- WHY. When the batch merge conflicts, the coordinator now enqueues a resolve-and
-- -reship turn in the conflicting thread (the agent that wrote the code fixes its own
-- conflict) instead of only parking + notifying. This counter caps that loop: after
-- MAX_CONFLICT_RETRIES self-resolve attempts the coordinator stops and falls back to
-- the human notification, so a genuinely unresolvable conflict can't spin forever.
--
-- Additive: one nullable-with-default integer column.

ALTER TABLE public.claude_deploy_queue
  ADD COLUMN IF NOT EXISTS conflict_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.claude_deploy_queue.conflict_attempts IS
  'Count of autonomous self-resolve turns the coordinator has enqueued for this row''s merge conflict. Caps the loop; see deploy-coordinator.ts.';
