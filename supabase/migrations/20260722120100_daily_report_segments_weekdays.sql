-- daily_report — per-question SEGMENT + WEEKDAYS (docs/daily-report-plan.md).
--
-- The daily check-in is filled at the START of the workday, so a question can
-- belong to one of two logical days:
--   • segment='end'   → it closes YESTERDAY (filled the next morning). Its
--                        answer is stored with entry_date = fill_date − 1.
--   • segment='start' → it opens TODAY. Answer stored with entry_date = fill_date.
-- The check-in dialog renders these as two sections ("סיום יום …" / "תחילת יום …")
-- with the Hebrew + Gregorian date of each. Consecutive fill-dates tile every
-- calendar day's questions with no overlap (a day's end lives in the next
-- morning's fill).
--
-- A question may also be relevant only on certain weekdays. `weekdays` is the
-- set of weekday numbers (0=Sunday … 6=Saturday, matching JS getDay) the
-- question applies to — referring to the day it BELONGS to (its entry_date).
-- NULL or empty = every day.

ALTER TABLE daily_report_items
  ADD COLUMN IF NOT EXISTS segment  text NOT NULL DEFAULT 'start'
    CHECK (segment IN ('start','end')),
  ADD COLUMN IF NOT EXISTS weekdays smallint[];

COMMENT ON COLUMN daily_report_items.segment IS
  'Which logical day the question belongs to: start=opens today, end=closes yesterday (filled next morning).';
COMMENT ON COLUMN daily_report_items.weekdays IS
  'Weekday numbers (0=Sun..6=Sat, by the entry_date it belongs to) the question applies to. NULL/empty = every day.';
