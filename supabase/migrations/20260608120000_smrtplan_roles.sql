-- ============================================================
-- smrtPlan — roles + role membership (default staffing by discipline)
-- ============================================================
-- A role is a discipline (designer / editor / tool-builder). Each role maps to
-- one or more people; exactly one is the primary (the default assignee). A
-- task / stage / estimate carries a role, and a new task auto-assigns to the
-- role's primary — overridable to any role member or anyone. Assignment is
-- always just a default; an explicit manual pick always wins.

CREATE TABLE IF NOT EXISTS smrtplan_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name_he    text NOT NULL,
  name_en    text,
  color      text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtplan_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_roles_org_members" ON smrtplan_roles;
CREATE POLICY "smrtplan_roles_org_members" ON smrtplan_roles
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_roles_org_idx ON smrtplan_roles(org_id);

CREATE TABLE IF NOT EXISTS smrtplan_role_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES smrtplan_roles(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_id, user_id)
);

ALTER TABLE smrtplan_role_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_role_members_org_members" ON smrtplan_role_members;
CREATE POLICY "smrtplan_role_members_org_members" ON smrtplan_role_members
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_role_members_role_idx ON smrtplan_role_members(role_id);
CREATE INDEX IF NOT EXISTS smrtplan_role_members_user_idx ON smrtplan_role_members(user_id);

-- At most one primary (default assignee) per role.
CREATE UNIQUE INDEX IF NOT EXISTS smrtplan_role_members_primary_uq
  ON smrtplan_role_members(role_id) WHERE is_primary;
