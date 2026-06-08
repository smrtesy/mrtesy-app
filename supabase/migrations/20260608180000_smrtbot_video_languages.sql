-- ============================================================
-- smrtBot — per-video language/domain availability
-- ============================================================
-- The catalog is org-wide, but each bot serves one domain/language (Hebrew bot
-- → rebbek.org, English bot → mymaor.org). Some videos are available only on
-- one domain (e.g. English-only videos that are NOT available in Hebrew).
--
-- `languages` lists the locale codes a video is available in, e.g.
--   {he}      → Hebrew only
--   {en}      → English only (won't be served/linked by the Hebrew bot)
--   {he,en}   → both
--   NULL/{}   → available everywhere (back-compat: existing rows are unchanged)
--
-- Each bot's locale is set in smrtbot_settings (key VIDEO_LOCALE, e.g. "he").
-- A bot serves a video when its locale is in the video's languages (or the
-- video has no languages set). Filtering happens in the engine (videos.ts).

ALTER TABLE smrtbot_videos
  ADD COLUMN IF NOT EXISTS languages text[];
