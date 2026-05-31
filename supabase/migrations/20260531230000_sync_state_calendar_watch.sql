-- Track the Google Calendar push notification channel per user so renewals can
-- stop the previous channel cleanly before creating a new one.
--
-- Why: calendar-renew-watch used a deterministic channel id ("calendar-{userId}")
-- and tried to stop the old channel with resourceId "primary". Google's
-- channels.stop requires the opaque resourceId returned at watch-creation time,
-- so the stop silently failed and the old channel stayed alive. Recreating with
-- the same id while it was still active raised 400 channelIdNotUnique on every
-- renewal cycle (the 6-day renew cron overlaps the 7-day channel ttl).
--
-- The function now uses a unique channel id each renewal and stores the channel
-- id + real resourceId here so the next run can stop it. These columns let that
-- persistence happen.
alter table public.sync_state
  add column if not exists watch_channel_id text,
  add column if not exists watch_resource_id text,
  add column if not exists watch_expiration timestamptz;
