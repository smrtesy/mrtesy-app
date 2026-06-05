-- ============================================================
-- smrtPlan — milestones can constrain the engine
-- ============================================================
-- A milestone optionally caps deadlines: constrains_user_id means "this date is
-- a hard ceiling for that person's tasks" (e.g. the designer's maternity leave
-- → all her tasks must finish by then). A milestone with a plan_id similarly
-- caps that plan's tasks. NULL on both = a display-only marker.

ALTER TABLE smrtplan_milestones
  ADD COLUMN IF NOT EXISTS constrains_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
