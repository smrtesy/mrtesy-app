-- Allow scanning more than one Drive folder per user.
--
-- Schema change: add `drive_folder_ids text[]` to user_settings, default
-- empty array. drive-sync (and part1) will prefer this column when
-- non-empty; the legacy singular `drive_folder_id` becomes a fallback
-- only — kept around so the existing behaviour doesn't change for any
-- user who hasn't migrated their preference through the new UI yet.
--
-- Initial data migration: if a user already picked a singular folder,
-- seed the new array with that one folder so they don't lose coverage
-- on the first edge-function run after deploy.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS drive_folder_ids text[] NOT NULL DEFAULT '{}';

UPDATE user_settings
SET    drive_folder_ids = ARRAY[drive_folder_id]
WHERE  drive_folder_id IS NOT NULL
  AND  (drive_folder_ids IS NULL OR cardinality(drive_folder_ids) = 0);
