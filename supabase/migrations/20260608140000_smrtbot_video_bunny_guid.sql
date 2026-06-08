-- ============================================================
-- smrtBot — Bunny Stream GUID mapping on the video index
-- ============================================================
-- Video hosting migrates from Vimeo to Bunny Stream. Metadata, permissions and
-- view tracking stay in Supabase (smrtbot_videos); Bunny handles only storage,
-- encoding and delivery. This column maps our video → the Bunny video GUID so
-- the white-labelled player (HLS from the per-bot custom CDN hostname, e.g.
-- video.rebbek.org) can resolve the stream. Additive + nullable: rows without a
-- GUID keep serving their existing link, so nothing breaks before migration.

ALTER TABLE smrtbot_videos
  ADD COLUMN IF NOT EXISTS bunny_video_guid text;

CREATE INDEX IF NOT EXISTS smrtbot_videos_bunny_guid_idx
  ON smrtbot_videos (org_id, bunny_video_guid) WHERE bunny_video_guid IS NOT NULL;
