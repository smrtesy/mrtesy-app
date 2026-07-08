-- Daily-method model (docs artifact "smrtTask — שיטת היום").
--
-- 1. Three effort sizes instead of two: quick | medium | big.
--    The old two-size model was quick|regular (default regular). "regular"
--    becomes "medium" (the neutral default); "big" is the new, explicitly-
--    marked large task (1/day in the method). Migrate existing rows first,
--    then swap the CHECK so no write of the retired 'regular' can sneak in.
ALTER TABLE tasks ALTER COLUMN size DROP DEFAULT;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_size_check;
UPDATE tasks SET size = 'medium' WHERE size = 'regular' OR size IS NULL;
ALTER TABLE tasks ALTER COLUMN size SET DEFAULT 'medium';
ALTER TABLE tasks ADD CONSTRAINT tasks_size_check CHECK (size IN ('quick', 'medium', 'big'));

-- 2. The day a task is committed to. planned_for = today  →  it is in "Today".
--    Picking a task for today sets this to today's date; the nightly rollover
--    (per-user midnight) clears stale picks so unfinished work returns to the
--    inbox. NULL = not planned (lives in the pool / inbox by the usual rules).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS planned_for date;
CREATE INDEX IF NOT EXISTS idx_tasks_planned_for
  ON tasks (planned_for)
  WHERE planned_for IS NOT NULL;

COMMENT ON COLUMN tasks.size IS
  'quick|medium|big — effort tier for the daily method (all quick + 3 medium + 1 big/day). Default medium.';
COMMENT ON COLUMN tasks.planned_for IS
  'The date a task is committed to. planned_for = today → shown in "Today". NULL = unplanned.';
