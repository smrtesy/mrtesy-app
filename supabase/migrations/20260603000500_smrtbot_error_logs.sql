-- ============================================================
-- smrtBot — error log (operator-facing, with full copy-able context)
-- ============================================================
-- Every attention-worthy smrtBot error (engine / webhook / cron / send / route)
-- is written here AND raised as a notifyError to the org's error handler, so it
-- shows up in the inbox and in a dedicated Errors panel with a Copy button.

CREATE TABLE smrtbot_error_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  area        text NOT NULL,            -- engine | webhook | cron | send | route
  title       text NOT NULL,
  message     text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  stack       text,
  resolved    boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_error_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_error_logs_org_members ON smrtbot_error_logs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_error_logs_org_idx ON smrtbot_error_logs (org_id, resolved, created_at DESC);
