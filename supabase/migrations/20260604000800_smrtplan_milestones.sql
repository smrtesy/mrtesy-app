-- ============================================================
-- smrtPlan — milestones (significant time points on the board)
-- ============================================================
-- Significant dates shown on the timeline as a labelled strip + thin vertical
-- lines through every row (so labels never stack on top of each other). A
-- milestone with plan_id = NULL is global (crosses the whole board, e.g. "the
-- designer goes on leave"); a milestone with a plan_id belongs to one row
-- (e.g. "new format goes live" on the format row).

CREATE TABLE IF NOT EXISTS smrtplan_milestones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id        uuid REFERENCES smrtplan_plans(id) ON DELETE CASCADE,  -- NULL = global
  milestone_date date NOT NULL,
  label_he       text NOT NULL,
  label_en       text,
  color          text,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtplan_milestones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_milestones_org_members" ON smrtplan_milestones;
CREATE POLICY "smrtplan_milestones_org_members" ON smrtplan_milestones
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_milestones_org_idx  ON smrtplan_milestones(org_id, milestone_date);
CREATE INDEX IF NOT EXISTS smrtplan_milestones_plan_idx ON smrtplan_milestones(plan_id) WHERE plan_id IS NOT NULL;
