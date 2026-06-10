-- org_invites: add UPDATE/DELETE policies for org owners/admins.
--
-- Why: the original policy set (20260517000001) gave org owners/admins only
-- SELECT and INSERT. Super admins have an unqualified ALL policy, but a regular
-- org owner/admin could not revoke or modify a pending invite via the client —
-- with RLS enabled and no matching policy, those mutations silently failed.
-- The backend revokes invites with the service-role key (which bypasses RLS),
-- so this is defense-in-depth that brings client capability in line with the
-- read/create policies. It only GRANTS access to the org's own admins; it
-- cannot widen access to other orgs (the org_members scope is identical to the
-- existing SELECT/INSERT policies).
--
-- Idempotent: drops the policies first so re-running is safe.

DROP POLICY IF EXISTS "org_admins_update_invites" ON org_invites;
CREATE POLICY "org_admins_update_invites" ON org_invites
  FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT user_id FROM org_members
      WHERE org_id = org_invites.org_id AND role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    auth.uid() IN (
      SELECT user_id FROM org_members
      WHERE org_id = org_invites.org_id AND role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "org_admins_delete_invites" ON org_invites;
CREATE POLICY "org_admins_delete_invites" ON org_invites
  FOR DELETE
  USING (
    auth.uid() IN (
      SELECT user_id FROM org_members
      WHERE org_id = org_invites.org_id AND role IN ('owner', 'admin')
    )
  );
