-- ============================================================
-- smrtTask — SMS ingestion (SMS Gateway for Android, self-hosted)
-- ============================================================
-- Adds a new inbound message channel: personal SMS forwarded from the user's
-- own Android phone by the open-source "SMS Gateway for Android" app
-- (https://sms-gate.app), which POSTs each received SMS to our webhook
-- (/api/webhooks/sms) signed with HMAC-SHA256.
--
-- Mirrors the WhatsApp design:
--   * sms_messages    — one row per received SMS (messageId), survives webhook
--                       re-delivery via UNIQUE(user_id, message_id).
--   * sms_connections — maps the gateway's deviceId → smrtTask user_id so the
--                       webhook can route an inbound SMS to the right tenant.
--                       The per-device HMAC signing key is stored in Vault
--                       (signing_key_id pointer), never in plaintext.
--
-- The webhook then upserts a per-message row into source_messages with
-- source_type='sms' so the existing ai-process pipeline classifies it and
-- creates tasks exactly as it does for WhatsApp/Gmail. OTP / one-time codes
-- are detected at ingestion and kept OUT of source_messages (stored only in
-- sms_messages with is_otp=true), so sensitive codes never reach the AI.

-- ============================================================
-- sms_messages
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id    text NOT NULL,                 -- gateway payload.messageId (content-based id)
  device_id     text,                          -- gateway deviceId that delivered it
  direction     text NOT NULL DEFAULT 'incoming'
                  CHECK (direction IN ('incoming','outgoing')),
  from_phone    text NOT NULL,                 -- payload.sender
  to_phone      text,                          -- payload.recipient (device number; nullable)
  sim_number    integer,                       -- payload.simNumber (nullable)
  body_text     text,
  is_otp        boolean NOT NULL DEFAULT false, -- looked like a one-time/verification code
  received_at   timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  raw_payload   jsonb,
  UNIQUE(user_id, message_id)
);

CREATE INDEX IF NOT EXISTS sms_messages_user_received_idx
  ON sms_messages(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS sms_messages_user_from_idx
  ON sms_messages(user_id, from_phone, received_at DESC);

ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_messages_owner" ON sms_messages;
CREATE POLICY "sms_messages_owner" ON sms_messages
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- sms_connections
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id             text NOT NULL UNIQUE,  -- gateway deviceId (envelope.deviceId)
  label                 text,                  -- user-facing name e.g. "הטלפון שלי"
  display_phone_number  text,                  -- optional, for display
  signing_key_id        uuid,                  -- Vault pointer to the HMAC signing key
  connected_at          timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz
);

CREATE INDEX IF NOT EXISTS sms_connections_user_idx
  ON sms_connections(user_id);

ALTER TABLE sms_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "sms_connections_owner" ON sms_connections;
CREATE POLICY "sms_connections_owner" ON sms_connections
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- Serial numbering — add the 'sms' source type (prefix 'M')
-- ============================================================
-- source_messages serials are per-source-type (G/S/W/E/D/C). SMS gets 'M'
-- (S is already taken by gmail_sent). See 20260518000005_serial_numbers.sql.

CREATE SEQUENCE IF NOT EXISTS source_msg_sms_seq;

-- Re-create the serial-assignment trigger function with an 'sms' branch added.
-- IMPORTANT: keep `SET search_path = public` — 20260527040000 hardened this
-- function's search_path, and a bare CREATE OR REPLACE would silently drop it.
CREATE OR REPLACE FUNCTION assign_source_message_serial()
RETURNS trigger AS $$
DECLARE
  v_prefix text;
  v_seq    text;
  v_next   bigint;
BEGIN
  IF NEW.serial IS NOT NULL THEN  -- preserve explicit values (e.g. backfill)
    RETURN NEW;
  END IF;
  CASE NEW.source_type
    WHEN 'gmail'           THEN v_prefix := 'G'; v_seq := 'source_msg_gmail_seq';
    WHEN 'gmail_sent'      THEN v_prefix := 'S'; v_seq := 'source_msg_gmail_sent_seq';
    WHEN 'whatsapp'        THEN v_prefix := 'W'; v_seq := 'source_msg_whatsapp_seq';
    WHEN 'whatsapp_echo'   THEN v_prefix := 'E'; v_seq := 'source_msg_whatsapp_echo_seq';
    WHEN 'google_drive'    THEN v_prefix := 'D'; v_seq := 'source_msg_drive_seq';
    WHEN 'google_calendar' THEN v_prefix := 'C'; v_seq := 'source_msg_calendar_seq';
    WHEN 'sms'             THEN v_prefix := 'M'; v_seq := 'source_msg_sms_seq';
    ELSE                        v_prefix := 'X'; v_seq := 'source_msg_unknown_seq';
  END CASE;
  v_next := nextval(v_seq);
  NEW.serial         := v_next;
  NEW.serial_display := v_prefix || v_next::text;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;
