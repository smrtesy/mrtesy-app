-- ============================================================
-- smrtPlan — tasks RLS: private vs organizational (build-spec §3.4)
-- ============================================================
-- Background: until now tasks were visible to ANY org member
-- (tasks_org_select keyed on organization_id). That is wrong for smrtPlan —
-- a personal scanned-email task must stay private to its owner, while a task
-- that is assigned or part of a plan should be visible org-wide by role.
--
-- The unified rule (the same flag drives plans and tasks):
--   • is_private = true  → owner only        (user_id = auth.uid())
--   • is_private = false → org members        (organizational, role-refined in API)
--
-- Safe default: the schema migration set tasks.is_private DEFAULT true and
-- backfilled every existing row to true, so NO existing personal task is
-- exposed by this change. Only a task explicitly marked organizational
-- (assigned, or part of a plan) becomes visible to the org.
--
-- Note: the tasks org column is `organization_id` (not `org_id`); the team
-- data path reads through the Express service-role client which bypasses RLS,
-- so this policy governs direct client reads (e.g. the realtime channel).
--
-- The pre-existing permissive `user_isolation` SELECT policy (user_id =
-- auth.uid(), defined on the base table) is intentionally RETAINED. RLS SELECT
-- policies are OR-ed, so the effective client-read rule becomes:
--   own tasks (any privacy)  OR  non-private tasks in my org
-- which is exactly the intended private/organizational split — do not drop
-- user_isolation thinking this policy is the only gate.

DROP POLICY IF EXISTS "tasks_org_select"           ON tasks;
DROP POLICY IF EXISTS "tasks_select_private_or_org" ON tasks;
CREATE POLICY "tasks_select_private_or_org" ON tasks
  FOR SELECT USING (
    (is_private = true  AND user_id = auth.uid())
    OR
    (is_private = false AND organization_id IN (
       SELECT org_id FROM org_members WHERE user_id = auth.uid()
    ))
  );
