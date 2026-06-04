-- Add legacy_id to the four smrtbot tables that were created without it
-- (children, diamonds_log, referral_log, publish_batches). The data-migration
-- script sets legacy_id on every row for the integer→uuid FK remap, so these
-- need the column too. Applied to prod during the botsite data migration.
ALTER TABLE smrtbot_children        ADD COLUMN IF NOT EXISTS legacy_id integer;
ALTER TABLE smrtbot_diamonds_log    ADD COLUMN IF NOT EXISTS legacy_id integer;
ALTER TABLE smrtbot_referral_log    ADD COLUMN IF NOT EXISTS legacy_id integer;
ALTER TABLE smrtbot_publish_batches ADD COLUMN IF NOT EXISTS legacy_id integer;
