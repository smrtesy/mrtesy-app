-- ============================================================
-- SMS — webhook diagnostic log
-- ============================================================
-- The inbound SMS webhook (/api/webhooks/sms) records every hit and its
-- outcome here so the user can see, from the SMS device screen, exactly what
-- their phone's SMS Gateway is (or isn't) delivering:
--   ingested | ignored | dropped   (+ a reason: auth:bad_token, unknown_device,
--   no_signing_key, missing_fields, otp_suppressed, empty_body, ignored:<event>, …)
-- An empty log after sending/receiving a message means the gateway is not
-- reaching us at all (wrong URL, app asleep in the background, no webhook
-- registered for that event). A `dropped` row with reason `bad_token` means the
-- token in the registered URL no longer matches the stored device secret.
--
-- Mirrors smrtbot_webhook_debug / whatsapp_webhook_debug.
CREATE TABLE IF NOT EXISTS sms_webhook_debug (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Resolved account when the device is known; NULL for hits we drop before
  -- (or because we cannot) resolve the connection (e.g. unknown_device).
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id    text,
  event        text,
  direction    text,          -- incoming | outgoing | NULL
  outcome      text NOT NULL, -- ingested | ignored | dropped
  reason       text,
  message_id   text,
  peer         text,          -- the other party's number (sender in / recipient out)
  body_preview text,
  payload      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sms_webhook_debug ENABLE ROW LEVEL SECURITY;

-- Owners read their own rows. Writes come from the service-role webhook client,
-- which bypasses RLS; the read endpoint is service-role and scopes by hand, so
-- this policy is the safety net for any direct client access.
CREATE POLICY sms_webhook_debug_owner ON sms_webhook_debug
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS sms_webhook_debug_user_idx
  ON sms_webhook_debug (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_webhook_debug_device_idx
  ON sms_webhook_debug (device_id, created_at DESC);
