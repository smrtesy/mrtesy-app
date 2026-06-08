-- ============================================================
-- smrtBot — per-subscriber video view log (real-time, queryable)
-- ============================================================
-- Append-only log: one row per successful playback authorization (the verify
-- endpoint writes it). Carries who (email/customer_id), what (video), which
-- link (jti) and when — so other apps can pull view data:
--   • smrtCRM      → views per contact / per link (join on email)
--   • smrtPlan     → activity signals
--   • dashboards   → counts, trends, top videos
-- In parallel the verify endpoint emits a `video.viewed` app_event, so apps can
-- also ingest views in real time by subscribing in their manifest.
--
-- org-scoped + RLS (org_members) so authenticated app pages can read it; the
-- service-role verify endpoint writes it (bypasses RLS).

CREATE TABLE IF NOT EXISTS smrtbot_video_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid REFERENCES smrtbot_bots(id) ON DELETE SET NULL,
  video       text,
  email       text,
  customer_id text,
  jti         uuid,
  ip          text,
  user_agent  text,
  watched_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_video_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_video_views_org_members ON smrtbot_video_views
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE INDEX smrtbot_video_views_org_time_idx  ON smrtbot_video_views (org_id, watched_at DESC);
CREATE INDEX smrtbot_video_views_org_email_idx ON smrtbot_video_views (org_id, email);
CREATE INDEX smrtbot_video_views_org_video_idx ON smrtbot_video_views (org_id, video);
