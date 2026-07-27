-- daily_report — re-link answers whose option_id was nulled by a settings save.
--
-- Background (found 2026-07-27): PUT /api/daily-report/config used to delete every
-- option row of every item and re-insert it on each save. daily_report_entries
-- .option_id is `REFERENCES daily_report_options(id) ON DELETE SET NULL`, so one
-- settings save nulled option_id on ALL historical answers. The answers survived
-- (option_label + score_snapshot are snapshotted on the entry, so reports stayed
-- correct), but:
--   • the check-in could no longer pre-select the user's own past answer, and
--   • /daily-report/pending tested `option_id != null` to decide "answered", so
--     every day before the last settings save read as never filled — which
--     collapsed its earliestEngaged trim to today and hid every missed day.
--
-- The route no longer deletes options it can update in place, and "answered" is
-- now row existence. This migration repairs the rows already orphaned: point each
-- one back at the option that carries the same label under the same item.
--
-- Idempotent (only touches option_id IS NULL) and deterministic (DISTINCT ON picks
-- the first option by position when an item has two options with the same label).
-- An entry whose label no longer exists as an option stays NULL and keeps its
-- snapshot — nothing is invented and nothing is lost.

UPDATE daily_report_entries e
SET option_id = sub.option_id
FROM (
  SELECT DISTINCT ON (user_id, item_id, label)
         user_id, item_id, label, id AS option_id
  FROM daily_report_options
  ORDER BY user_id, item_id, label, position, created_at
) sub
WHERE e.option_id IS NULL
  AND sub.user_id = e.user_id
  AND sub.item_id = e.item_id
  AND sub.label   = e.option_label;
