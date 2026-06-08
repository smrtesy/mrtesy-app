-- ============================================================
-- smrtBot — subscriber identity (email link) + OTP verification
-- ============================================================
-- Identity is by EMAIL. The bot maps a WhatsApp phone → a verified email and
-- (entitlement always comes from the external subscription system, never
-- decided locally). This migration only adds STORAGE; all new runtime
-- behaviour is config-gated in the app (app_secrets, slug "smrtbot"):
--   SUBSCRIPTION_API_BASE_URL, SUBSCRIPTION_API_SECRET,
--   VIDEO_WATCH_BASE_URL, VIDEO_TOKEN_SECRET,
--   VIDEO_OTP_FROM_EMAIL, VIDEO_OTP_SES_REGION
-- With none of those set the bot behaves exactly as before.
--
-- org-scoped + RLS consistent with the rest of the smrtbot schema. The engine
-- uses the service-role client (bypasses RLS); the policies gate the admin UI.

-- ── 1. email identity on the per-bot WhatsApp user ──────────────────────────
ALTER TABLE smrtbot_wa_users
  ADD COLUMN IF NOT EXISTS email                  text,
  ADD COLUMN IF NOT EXISTS email_verified_at       timestamptz,
  ADD COLUMN IF NOT EXISTS first_name              text,
  ADD COLUMN IF NOT EXISTS last_name               text,
  ADD COLUMN IF NOT EXISTS external_customer_id    text,
  ADD COLUMN IF NOT EXISTS subscriber_status       text,
  ADD COLUMN IF NOT EXISTS subscription_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS smrtbot_wa_users_email_idx
  ON smrtbot_wa_users (bot_id, email) WHERE email IS NOT NULL;

-- ── 2. email-ownership OTP codes (short-lived, hashed) ──────────────────────
CREATE TABLE IF NOT EXISTS smrtbot_email_otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  email       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_email_otps ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_email_otps_org_members ON smrtbot_email_otps
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_email_otps_lookup_idx
  ON smrtbot_email_otps (bot_id, phone, created_at DESC);
