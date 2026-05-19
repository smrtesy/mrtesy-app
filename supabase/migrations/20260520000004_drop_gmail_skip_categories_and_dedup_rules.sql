-- Rollback: the per-user gmail_skip_categories column from migration
-- 20260520000003 was redundant with the existing rules_memory mechanism
-- (trigger='category=<promotions|social|forums|updates>'). ai-process v18
-- reads those rules instead, with smart defaults baked in (promotions /
-- social / forums = filter; updates = NOT filter).

ALTER TABLE user_settings DROP COLUMN IF EXISTS gmail_skip_categories;

-- The rules page used to INSERT without checking for duplicates, so a
-- handful of users had multiple rows for the same (user_id, trigger).
-- Dedup keeps the newest row.
DELETE FROM rules_memory r1
USING rules_memory r2
WHERE r1.user_id = r2.user_id
  AND r1.trigger = r2.trigger
  AND r1.id != r2.id
  AND r1.created_at < r2.created_at;

-- Prevent future duplicates. Lets the rules page upsert in one round-trip.
ALTER TABLE rules_memory
  ADD CONSTRAINT rules_memory_user_trigger_unique UNIQUE (user_id, trigger);
