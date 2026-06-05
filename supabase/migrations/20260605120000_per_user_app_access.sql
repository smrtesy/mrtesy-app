-- Per-user app access + carry chosen apps on invites.
--
-- Until now app access was purely org-level (app_memberships): every member of
-- an org could use every app the org had enabled. This adds a per-user grant so
-- an owner/admin can decide which apps each *member* receives.
--
-- Enforcement model (decided with the product owner):
--   • Owners/admins (and super-admins) are UNRESTRICTED — they implicitly have
--     every app the org has enabled.
--   • role='member' is restricted to the apps explicitly granted to them here.
--
-- Both the backend `requireApp` middleware and the frontend sidebar/settings
-- intersect org-enabled apps with these per-user grants for members.

-- ─── 1. Per-user app grants ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_app_access (
  org_id     uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  app_id     uuid        NOT NULL REFERENCES apps(id)          ON DELETE CASCADE,
  granted_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, app_id)
);
CREATE INDEX IF NOT EXISTS user_app_access_org_user_idx ON user_app_access (org_id, user_id);

ALTER TABLE user_app_access ENABLE ROW LEVEL SECURITY;

-- A user may read their own grants (sidebar/settings visibility).
DROP POLICY IF EXISTS "user_app_access_select_self" ON user_app_access;
CREATE POLICY "user_app_access_select_self" ON user_app_access
  FOR SELECT USING (user_id = auth.uid());

-- Org owners/admins may read every grant in their org (to manage members' apps).
DROP POLICY IF EXISTS "user_app_access_select_admins" ON user_app_access;
CREATE POLICY "user_app_access_select_admins" ON user_app_access
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Super admins: full access.
DROP POLICY IF EXISTS "user_app_access_super_admins" ON user_app_access;
CREATE POLICY "user_app_access_super_admins" ON user_app_access
  USING (auth.uid() IN (SELECT user_id FROM super_admins));

-- Writes happen through the service-role backend (bypasses RLS) or the
-- accept_my_invites() SECURITY DEFINER function below — so no INSERT/UPDATE/
-- DELETE policies are granted to regular authenticated users.

-- ─── 2. Carry chosen apps on the invite (applied on accept) ──────────────────
ALTER TABLE org_invites ADD COLUMN IF NOT EXISTS app_slugs text[] NOT NULL DEFAULT '{}';

-- Invites that are still pending predate per-user apps (under the old model an
-- accepted member got every app the org had enabled). Preserve that intent so
-- nobody who accepts an old invite lands in an empty, all-forbidden account:
-- grant them every app their org currently has enabled.
UPDATE org_invites i
SET app_slugs = COALESCE((
  SELECT array_agg(a.slug)
  FROM app_memberships am
  JOIN apps a ON a.id = am.app_id
  WHERE am.org_id = i.org_id
), '{}')
WHERE accepted_at IS NULL
  AND expires_at > now()
  AND app_slugs = '{}';

-- ─── 3. Backfill ─────────────────────────────────────────────────────────────
-- Every existing member keeps access to all apps their org has enabled today,
-- so nobody loses access the moment per-user enforcement turns on.
INSERT INTO user_app_access (org_id, user_id, app_id, granted_by)
SELECT am.org_id, om.user_id, am.app_id, NULL
FROM app_memberships am
JOIN org_members om ON om.org_id = am.org_id
ON CONFLICT (org_id, user_id, app_id) DO NOTHING;

-- ─── 4. accept_my_invites() ──────────────────────────────────────────────────
-- Atomically applies all pending, non-expired invites for the caller's email:
-- joins each org and grants the per-user apps the inviter chose. SECURITY
-- DEFINER so it works under the caller's RLS-bound web session (org_members /
-- user_app_access have no end-user INSERT policy) without depending on a
-- service-role key in the web tier. Idempotent — safe to call on every login.
CREATE OR REPLACE FUNCTION accept_my_invites()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email  text;
  v_invite record;
BEGIN
  SELECT lower(email) INTO v_email FROM auth.users WHERE id = auth.uid();
  IF v_email IS NULL THEN
    RETURN;
  END IF;

  FOR v_invite IN
    SELECT * FROM org_invites
    WHERE lower(email) = v_email
      AND accepted_at IS NULL
      AND expires_at > now()
    ORDER BY created_at
  LOOP
    INSERT INTO org_members (org_id, user_id, role, invited_by)
    VALUES (v_invite.org_id, auth.uid(), v_invite.role, v_invite.invited_by)
    ON CONFLICT (org_id, user_id) DO NOTHING;

    INSERT INTO user_app_access (org_id, user_id, app_id, granted_by)
    SELECT v_invite.org_id, auth.uid(), a.id, v_invite.invited_by
    FROM apps a
    WHERE a.slug = ANY (v_invite.app_slugs)
    ON CONFLICT (org_id, user_id, app_id) DO NOTHING;

    UPDATE org_invites SET accepted_at = now() WHERE id = v_invite.id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION accept_my_invites() TO authenticated;
