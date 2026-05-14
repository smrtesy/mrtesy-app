-- ============================================================================
-- Fix: infinite recursion in org_members SELECT policy.
--
-- The original policy `org_id IN (SELECT org_id FROM org_members ...)` triggered
-- the same policy again on its inner subquery — Postgres bails with 42P17.
--
-- Cross-member queries (listing teammates of an org) now go through Express
-- (which uses the service-role client and bypasses RLS), so RLS on org_members
-- only needs to allow each user to see their OWN membership rows.
-- ============================================================================

DROP POLICY IF EXISTS "org_members_select" ON org_members;
CREATE POLICY "org_members_select" ON org_members
  FOR SELECT USING (user_id = auth.uid());

-- Re-apply tasks/projects org-aware policies (they subquery org_members,
-- which is now safely non-recursive).
DROP POLICY IF EXISTS "tasks_org_select" ON tasks;
CREATE POLICY "tasks_org_select" ON tasks
  FOR SELECT USING (
    organization_id IS NULL
    OR organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "projects_org_select" ON projects;
CREATE POLICY "projects_org_select" ON projects
  FOR SELECT USING (
    organization_id IS NULL
    OR organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );
