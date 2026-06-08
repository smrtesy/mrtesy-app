-- ============================================================
-- smrtPlan — plan lifecycle + capabilities, role links, dependency lag
-- ============================================================
-- All additive: new columns are nullable or defaulted so existing code and
-- rows keep working. Each is wired up by a later feature slice.

-- Plan approval lifecycle + capability flags.
--   status: draft (free planning, tasks stay silent) → active (approved/live) →
--           done (finished; for a capability this means "available") → archived.
--           Default 'active' so every existing plan is unaffected.
--   is_capability: a one-time, reusable tool/enabler (vs a deliverable/event).
--                  Set when the row is created; drives "vanish to the shelf when
--                  done" and the green "based on" badge on dependents.
--   is_available:  for a capability, whether it is usable right now. Marking it
--                  unavailable re-blocks OPEN dependents (engine, later slice).
ALTER TABLE smrtplan_plans
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft','active','done','archived')),
  ADD COLUMN IF NOT EXISTS is_capability boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_available  boolean NOT NULL DEFAULT true;

-- Default-staffing role links. The role on a task/stage/estimate drives the
-- default assignee (the role's primary). Nullable: existing rows have no role.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES smrtplan_roles(id) ON DELETE SET NULL;
ALTER TABLE smrtplan_stages
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES smrtplan_roles(id) ON DELETE SET NULL;
ALTER TABLE smrtplan_estimates
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES smrtplan_roles(id) ON DELETE SET NULL;

-- Dependency lag: a WORKING-DAY buffer between the provider's finish and the
-- consumer's start (e.g. "translation ready two weeks before release"). The
-- engine reads it in a later slice; 0 = back-to-back (today's behaviour).
ALTER TABLE smrtplan_dependencies
  ADD COLUMN IF NOT EXISTS lag_days int NOT NULL DEFAULT 0;
