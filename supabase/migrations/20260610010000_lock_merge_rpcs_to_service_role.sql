-- SECURITY FIX — lock the task-merge RPCs to service_role only.
--
-- merge_tasks() and undo_task_merge() are SECURITY DEFINER functions that
-- bypass RLS and trust the caller-supplied p_org_id / p_user_id arguments —
-- they validate that the tasks belong to the *passed* org, but NOT that the
-- caller (auth.uid()) is a member of that org. Their entire isolation model
-- depends on being callable only by the service-role backend, which verifies
-- auth + org membership in middleware before invoking them.
--
-- The original migration (20260528150100) revoked PUBLIC and granted only
-- service_role, but the production database currently has these functions
-- executable by `anon` and `authenticated` (confirmed via Supabase security
-- advisors 0028/0029) — the grant drifted (a CREATE OR REPLACE resets a
-- function's ACL to the PUBLIC default, and the revoke was not re-applied).
--
-- Live impact while exposed: any authenticated — or even anonymous — caller
-- could POST /rest/v1/rpc/merge_tasks with another org's p_org_id and, with
-- p_target_id NULL + empty p_source_ids, INSERT an arbitrary task into that
-- org (no UUID knowledge required); or, knowing task UUIDs, archive/complete
-- another org's tasks; undo_task_merge could DELETE another org's task.
--
-- This re-asserts the intended grants. It is safe: the Node backend calls
-- these through the service-role client, which retains EXECUTE; no frontend
-- or client path calls them directly. Idempotent — safe to run repeatedly.

REVOKE ALL ON FUNCTION merge_tasks(uuid, uuid, uuid[], uuid, jsonb, uuid[], text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_tasks(uuid, uuid, uuid[], uuid, jsonb, uuid[], text, jsonb)
  TO service_role;

REVOKE ALL ON FUNCTION undo_task_merge(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION undo_task_merge(uuid, uuid, uuid)
  TO service_role;
