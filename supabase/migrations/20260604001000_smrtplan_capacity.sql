-- ============================================================
-- smrtPlan — worker capacity (decisions ה.11)
-- ============================================================
-- Per org × user: which weekdays they work and how many hours per work-day.
-- Used in planning to estimate how many calendar days a task needs for a given
-- assignee (effort-hours ÷ hours_per_day, spread over their working weekdays —
-- which already skip Shabbat/yom tov via the engine's blocked-day calendar).
--
-- work_days: ISO-ish weekday numbers 0=Sunday … 6=Saturday. Default Sun–Thu
-- (Maor's core week); Friday/Shabbat off by default. hours_per_day default 8.

CREATE TABLE IF NOT EXISTS smrtplan_capacity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  work_days     int[]   NOT NULL DEFAULT '{0,1,2,3,4}',
  hours_per_day numeric NOT NULL DEFAULT 8 CHECK (hours_per_day >= 0 AND hours_per_day <= 24),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);

ALTER TABLE smrtplan_capacity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "smrtplan_capacity_org_members" ON smrtplan_capacity;
CREATE POLICY "smrtplan_capacity_org_members" ON smrtplan_capacity
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtplan_capacity_org_idx ON smrtplan_capacity(org_id);
