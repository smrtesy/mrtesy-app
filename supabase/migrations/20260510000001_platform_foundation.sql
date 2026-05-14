-- ============================================================================
-- Migration: Platform Foundation (Phase 1)
--   • Tenancy tables: organizations, org_members
--   • App registry: apps, app_memberships
--   • Task assignment: tasks.assigned_to_user_id
--   • Backfill: create a "Personal" org for every existing user
--               + set organization_id on their existing tasks/projects
--   • RLS: org-scoped isolation on new tables
--
-- Safe to re-run (uses IF NOT EXISTS / ON CONFLICT guards).
-- ============================================================================


-- ─── 1. organizations ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS organizations (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text          NOT NULL UNIQUE,
  name        text          NOT NULL,
  name_he     text,
  created_by  uuid          NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orgs_created_by ON organizations (created_by);


-- ─── 2. org_members ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_members (
  org_id      uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid          NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  role        text          NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_by  uuid          REFERENCES auth.users(id),
  joined_at   timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id);


-- ─── 3. apps (registry of installable modules) ──────────────────────────────

CREATE TABLE IF NOT EXISTS apps (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text          NOT NULL UNIQUE,
  name        text          NOT NULL,
  description text,
  created_at  timestamptz   NOT NULL DEFAULT now()
);

-- Seed smrtesy as the first app (idempotent)
INSERT INTO apps (slug, name, description)
VALUES ('smrtesy', 'smrtesy AI Brain', 'Gmail, WhatsApp, Drive & Calendar AI assistant')
ON CONFLICT (slug) DO NOTHING;


-- ─── 4. app_memberships (which orgs have which apps enabled) ────────────────

CREATE TABLE IF NOT EXISTS app_memberships (
  org_id      uuid          NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id      uuid          NOT NULL REFERENCES apps(id)           ON DELETE CASCADE,
  enabled_by  uuid          NOT NULL REFERENCES auth.users(id),
  enabled_at  timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, app_id)
);


-- ─── 5. Extend tasks with assignment ────────────────────────────────────────

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS assigned_to_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks (assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks (organization_id)
  WHERE organization_id IS NOT NULL;


-- ─── 6. BACKFILL: create a Personal org per existing user ───────────────────
-- For every user who has tasks or projects but no org, create "Personal" org
-- and link them as owner, then stamp all their existing data with that org_id.

DO $$
DECLARE
  u_id uuid;
  new_org_id uuid;
  smrtesy_id uuid;
BEGIN
  -- Get the smrtesy app id once
  SELECT id INTO smrtesy_id FROM apps WHERE slug = 'smrtesy';

  FOR u_id IN
    SELECT DISTINCT user_id FROM (
      SELECT user_id FROM tasks
      UNION
      SELECT user_id FROM projects
    ) all_users
    WHERE user_id IS NOT NULL
      AND user_id NOT IN (SELECT user_id FROM org_members)   -- skip users already in an org
  LOOP
    -- Create the personal org
    INSERT INTO organizations (slug, name, created_by)
    VALUES (
      'personal-' || substr(u_id::text, 1, 8),
      'Personal',
      u_id
    )
    RETURNING id INTO new_org_id;

    -- Add user as owner
    INSERT INTO org_members (org_id, user_id, role, invited_by)
    VALUES (new_org_id, u_id, 'owner', u_id);

    -- Enable smrtesy for the personal org (since they're already using it)
    INSERT INTO app_memberships (org_id, app_id, enabled_by)
    VALUES (new_org_id, smrtesy_id, u_id);

    -- Backfill: stamp this user's existing tasks + projects with the new org
    UPDATE tasks    SET organization_id = new_org_id WHERE user_id = u_id AND organization_id IS NULL;
    UPDATE projects SET organization_id = new_org_id WHERE user_id = u_id AND organization_id IS NULL;
  END LOOP;
END $$;


-- ─── 7. RLS — Row Level Security on the new tables ──────────────────────────
-- The pattern: you can only see rows belonging to orgs you're a member of.

ALTER TABLE organizations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_memberships  ENABLE ROW LEVEL SECURITY;

-- organizations: visible if you're a member
DROP POLICY IF EXISTS "orgs_select_members" ON organizations;
CREATE POLICY "orgs_select_members" ON organizations
  FOR SELECT USING (
    id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

-- organizations: owners/admins can update
DROP POLICY IF EXISTS "orgs_update_admins" ON organizations;
CREATE POLICY "orgs_update_admins" ON organizations
  FOR UPDATE USING (
    id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
  );

-- org_members: visible to all members of the same org
DROP POLICY IF EXISTS "org_members_select" ON org_members;
CREATE POLICY "org_members_select" ON org_members
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members om WHERE om.user_id = auth.uid())
  );

-- apps: everyone can read the registry (it's a list of installable apps)
DROP POLICY IF EXISTS "apps_select_all" ON apps;
CREATE POLICY "apps_select_all" ON apps FOR SELECT USING (true);

-- app_memberships: visible if you're a member of the org
DROP POLICY IF EXISTS "app_memberships_select" ON app_memberships;
CREATE POLICY "app_memberships_select" ON app_memberships
  FOR SELECT USING (
    org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );


-- ─── 8. Update RLS on tasks/projects to be org-aware ────────────────────────
-- Note: existing user_id-based policies stay in place; we add an org check too.

DROP POLICY IF EXISTS "tasks_org_select" ON tasks;
CREATE POLICY "tasks_org_select" ON tasks
  FOR SELECT USING (
    organization_id IS NULL  -- legacy rows without org (shouldn't exist after backfill)
    OR organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "projects_org_select" ON projects;
CREATE POLICY "projects_org_select" ON projects
  FOR SELECT USING (
    organization_id IS NULL
    OR organization_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid())
  );


-- ─── 9. updated_at trigger for organizations ────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_orgs_updated_at ON organizations;
CREATE TRIGGER trg_orgs_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
