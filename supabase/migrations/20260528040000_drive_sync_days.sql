-- Add configurable scan depth for Google Drive (days back from today).
-- Default 30 days matches the UI default. The drive-sync edge function
-- reads this value and applies it as a modifiedTime filter.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS drive_sync_days integer NOT NULL DEFAULT 30;
