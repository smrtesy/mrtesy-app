-- ============================================================
-- smrtPlan — plan templates ("marketing = 4 stages")
-- ============================================================
-- A template is a reusable blueprint: an ordered set of task items (each with a
-- role + default duration) plus a dependency chain between them. Applying a
-- template spins up a new effort plan and generates the tasks, their default
-- assignees (the role's primary), and the dependency edges in one shot.
--
-- All org-scoped, RLS by org membership — same pattern as the rest of smrtPlan.

CREATE TABLE IF NOT EXISTS smrtplan_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name_he     text NOT NULL,
  name_en     text,
  description text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtplan_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_templates_org_members" ON smrtplan_templates;
CREATE POLICY "smrtplan_templates_org_members" ON smrtplan_templates
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- Each task blueprint in a template.
CREATE TABLE IF NOT EXISTS smrtplan_template_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id           uuid NOT NULL REFERENCES smrtplan_templates(id) ON DELETE CASCADE,
  title_he              text NOT NULL,
  title_en              text,
  role_id               uuid REFERENCES smrtplan_roles(id) ON DELETE SET NULL,
  default_duration_days numeric,
  sequence              int NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtplan_template_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_template_items_org_members" ON smrtplan_template_items;
CREATE POLICY "smrtplan_template_items_org_members" ON smrtplan_template_items
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_template_items_tpl_idx ON smrtplan_template_items(template_id, sequence);

-- Dependency edges between items (from = consumer/needs, to = provider — same
-- direction as smrtplan_dependencies). lag = finish-to-finish buffer in days.
CREATE TABLE IF NOT EXISTS smrtplan_template_deps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  template_id  uuid NOT NULL REFERENCES smrtplan_templates(id) ON DELETE CASCADE,
  from_item_id uuid NOT NULL REFERENCES smrtplan_template_items(id) ON DELETE CASCADE,
  to_item_id   uuid NOT NULL REFERENCES smrtplan_template_items(id) ON DELETE CASCADE,
  lag_days     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_item_id, to_item_id)
);
ALTER TABLE smrtplan_template_deps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_template_deps_org_members" ON smrtplan_template_deps;
CREATE POLICY "smrtplan_template_deps_org_members" ON smrtplan_template_deps
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_template_deps_tpl_idx ON smrtplan_template_deps(template_id);
