-- ============================================================================
-- Migration: allow each user to read their own super_admins row.
--
-- Server-side Next.js code (the /admin layout) needs to know "is the current
-- user a super-admin?" using the user-scoped Supabase client (no service-role).
-- Without this policy, all reads were blocked.
--
-- Cross-user reads still go through Express + service-role (which bypasses RLS).
-- ============================================================================

DROP POLICY IF EXISTS "super_admins_no_direct_access" ON super_admins;
DROP POLICY IF EXISTS "super_admins_self_read" ON super_admins;

-- Each user can read their own row (and only their own).
CREATE POLICY "super_admins_self_read" ON super_admins
  FOR SELECT USING (user_id = auth.uid());

-- Writes (INSERT/UPDATE/DELETE) remain blocked — those go through the API.
