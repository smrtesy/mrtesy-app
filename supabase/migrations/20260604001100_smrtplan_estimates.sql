-- ============================================================
-- smrtPlan — task hour estimates catalog (a.2 → effort estimation)
-- ============================================================
-- A reusable library of task types and their estimated effort in hours, refined
-- over time. The optional description lets an AI tool match a real task to the
-- right estimate. Estimated hours ÷ the assignee's capacity (hours/day, from
-- smrtplan_capacity) gives the duration the engine schedules with.

CREATE TABLE IF NOT EXISTS smrtplan_estimates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  hours       numeric NOT NULL DEFAULT 0 CHECK (hours >= 0),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtplan_estimates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_estimates_org_members" ON smrtplan_estimates;
CREATE POLICY "smrtplan_estimates_org_members" ON smrtplan_estimates
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_estimates_org_idx ON smrtplan_estimates(org_id);
