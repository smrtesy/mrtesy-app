-- Add today_position to tasks for the "Today" work-plan section.
-- NULL  = task is in "הכל" (All) list.
-- 0,1,2 = position in "היום" (Today) list, ascending order.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS today_position integer;

CREATE INDEX IF NOT EXISTS idx_tasks_today_position
  ON tasks (organization_id, today_position)
  WHERE today_position IS NOT NULL;
