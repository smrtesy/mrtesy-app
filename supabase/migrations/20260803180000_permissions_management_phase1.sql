-- Permissions management — phase 1
--
-- Layers an "open-by-default, restrict-specific-things" model ON TOP of the
-- existing app entitlement (user_app_access) — it does NOT replace it. Within
-- an app a member already has, everything is open by default; an org admin may
-- mark specific SCREENS / SUB-SCREENS / DANGEROUS ACTIONS as restricted, and
-- grant per-user exceptions.
--
-- The CATALOG of what CAN be restricted lives in CODE
-- (src/lib/permissions/registry.ts + its server twin), not in a table — the
-- code is the single source of truth, and resource_key values here are
-- validated against it at write time on the backend. So there is no
-- restrictable_resources table; these three tables store only org policy,
-- per-user exceptions, and an audit trail.
--
-- Design doc: docs/permissions-management-plan.md
--
-- Phase 2 (NOT built here) adds an access_requests table + the request→approve
-- loop and cost-gated actions. The audit `action` CHECK below already includes
-- 'request'/'approve'/'deny' so phase 2 needs no constraint change.

-- ─── 1. org_restrictions — which catalog resources an org restricts ──────────
-- Absence of a row = fall back to the registry's defaultRestricted (normally
-- false = open). A row makes the org's choice explicit.
CREATE TABLE IF NOT EXISTS org_restrictions (
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_key text        NOT NULL,
  restricted   boolean     NOT NULL DEFAULT true,
  updated_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, resource_key)
);
CREATE INDEX IF NOT EXISTS org_restrictions_org_idx ON org_restrictions (org_id);

ALTER TABLE org_restrictions ENABLE ROW LEVEL SECURITY;

-- Any member of the org may READ its restrictions — the frontend resolves the
-- signed-in user's locked set under their own RLS-bound session.
DROP POLICY IF EXISTS "org_restrictions_select_members" ON org_restrictions;
CREATE POLICY "org_restrictions_select_members" ON org_restrictions
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- Super admins: full access (they manage any org).
DROP POLICY IF EXISTS "org_restrictions_super_admins" ON org_restrictions;
CREATE POLICY "org_restrictions_super_admins" ON org_restrictions
  USING (auth.uid() IN (SELECT user_id FROM super_admins));

-- Writes happen through the service-role backend (bypasses RLS). No end-user
-- INSERT/UPDATE/DELETE policies are granted.

-- ─── 2. user_resource_grants — per-user exception to a restriction ───────────
-- A member with an active grant (revoked_at IS NULL) passes the restriction on
-- that resource. `source` records how it was granted: 'admin' (given directly),
-- 'request' (phase-2 approval of a request), 'system' (automatic).
CREATE TABLE IF NOT EXISTS user_resource_grants (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES auth.users(id)    ON DELETE CASCADE,
  resource_key text        NOT NULL,
  source       text        NOT NULL DEFAULT 'admin'
                 CHECK (source IN ('admin', 'request', 'system')),
  granted_by   uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
-- At most one ACTIVE grant per (org, user, resource); revoked rows are kept for
-- the audit trail and don't block a fresh grant.
CREATE UNIQUE INDEX IF NOT EXISTS user_resource_grants_active_uk
  ON user_resource_grants (org_id, user_id, resource_key)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_resource_grants_lookup
  ON user_resource_grants (org_id, user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE user_resource_grants ENABLE ROW LEVEL SECURITY;

-- A user may read their own grants (to know what they've been let into).
DROP POLICY IF EXISTS "user_resource_grants_select_self" ON user_resource_grants;
CREATE POLICY "user_resource_grants_select_self" ON user_resource_grants
  FOR SELECT USING (user_id = auth.uid());

-- Org owners/admins may read every grant in their org (to manage exceptions).
DROP POLICY IF EXISTS "user_resource_grants_select_admins" ON user_resource_grants;
CREATE POLICY "user_resource_grants_select_admins" ON user_resource_grants
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

-- Super admins: full access.
DROP POLICY IF EXISTS "user_resource_grants_super_admins" ON user_resource_grants;
CREATE POLICY "user_resource_grants_super_admins" ON user_resource_grants
  USING (auth.uid() IN (SELECT user_id FROM super_admins));

-- ─── 3. permission_audit_log — every permission change ───────────────────────
CREATE TABLE IF NOT EXISTS permission_audit_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_user_id  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  action         text        NOT NULL
                   CHECK (action IN ('restrict', 'unrestrict', 'grant', 'revoke',
                                     'request', 'approve', 'deny')),
  target_user_id uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  resource_key   text,
  details        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permission_audit_log_org_idx
  ON permission_audit_log (org_id, created_at DESC);

ALTER TABLE permission_audit_log ENABLE ROW LEVEL SECURITY;

-- Only org owners/admins (their org) and super admins may read the audit trail.
DROP POLICY IF EXISTS "permission_audit_log_select_admins" ON permission_audit_log;
CREATE POLICY "permission_audit_log_select_admins" ON permission_audit_log
  FOR SELECT USING (
    org_id IN (
      SELECT org_id FROM org_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "permission_audit_log_super_admins" ON permission_audit_log;
CREATE POLICY "permission_audit_log_super_admins" ON permission_audit_log
  USING (auth.uid() IN (SELECT user_id FROM super_admins));
