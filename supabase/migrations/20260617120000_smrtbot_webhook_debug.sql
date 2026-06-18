-- ============================================================
-- smrtBot — webhook diagnostic log
-- ============================================================
-- The per-bot Meta callback (/api/webhooks/smrtbot/<ref>) records every hit and
-- its outcome here so connection problems are visible from the UI:
--   received | bot_not_found | not_meta | bad_signature | no_app_secret | forwarded
-- An empty log after sending a message means Meta is not delivering to us
-- (e.g. app still in Development/unpublished, or wrong callback URL).
CREATE TABLE smrtbot_webhook_debug (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  slug        text,
  outcome     text NOT NULL,
  detail      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_webhook_debug ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_webhook_debug_org_members ON smrtbot_webhook_debug
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_webhook_debug_idx ON smrtbot_webhook_debug (bot_id, created_at DESC);
