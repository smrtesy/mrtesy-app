-- Per-person working days on the focus commitment (docs/smrtplan-focus-integration.md).
-- The daily manager alert (feature 2) must respect each performer's OWN work week
-- — e.g. someone who works Mon–Thu only should never be flagged for "missing"
-- their focus task on a Friday. Until now workdays were org-global (Mon–Fri, see
-- src/lib/workdays.ts); this adds a personal override that lives ONLY on the
-- execution layer (the focus commitment) and never touches the scheduling engine.
--
--   workdays — an int[] of day-of-week numbers that ARE working days, using the
--              JS getUTCDay() convention (0=Sunday … 6=Saturday). NULL/empty means
--              "use the org default" (Mon–Fri = {1,2,3,4,5}). Israeli holidays
--              (smrtplan_blocked_days) still apply on top of the personal mask.

ALTER TABLE smrtplan_focus
  ADD COLUMN IF NOT EXISTS workdays integer[];

COMMENT ON COLUMN smrtplan_focus.workdays IS
  'Personal working days as day-of-week numbers (0=Sun..6=Sat, JS getUTCDay). '
  'NULL/empty = org default (Mon–Fri). Used by the daily manager alert only; '
  'holidays from smrtplan_blocked_days still apply on top.';
