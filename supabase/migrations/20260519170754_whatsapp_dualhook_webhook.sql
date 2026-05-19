-- Replaces the Google Sheet ingestion path for WhatsApp with a direct
-- Meta Cloud API webhook (routed via DualHook's Webhook Override).
--
-- Adds:
--   * whatsapp_messages    — one row per Meta message (wamid), survives across
--                            history chunks via UNIQUE(user_id, wamid).
--   * whatsapp_connections — maps Meta phone_number_id → smrtTask user_id, so
--                            the webhook can route incoming events to the right
--                            tenant. The Coexistence "Access Token" lives in
--                            env (single tenant for now).
--
-- The existing source_messages table is unchanged: every webhook event still
-- causes a per-chat upsert into source_messages with the same shape Part 2
-- used to produce, so Part 3 keeps working unchanged.

-- ============================================================
-- whatsapp_messages
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wamid           text NOT NULL,
  chat_id         text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  from_phone      text NOT NULL,
  from_name       text,
  to_phone        text,
  message_type    text NOT NULL,
  body_text       text,
  media_id        text,
  media_mime      text,
  reply_to_wamid  text,
  reaction_emoji  text,
  is_reaction     boolean NOT NULL DEFAULT false,
  is_history      boolean NOT NULL DEFAULT false,
  history_phase   integer,
  received_at     timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  raw_payload     jsonb,
  UNIQUE(user_id, wamid)
);

CREATE INDEX IF NOT EXISTS whatsapp_messages_user_chat_idx
  ON whatsapp_messages(user_id, chat_id, received_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_user_received_idx
  ON whatsapp_messages(user_id, received_at DESC);

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "whatsapp_messages_owner" ON whatsapp_messages;
CREATE POLICY "whatsapp_messages_owner" ON whatsapp_messages
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- whatsapp_connections
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number_id       text NOT NULL UNIQUE,
  waba_id               text,
  display_phone_number  text,
  connected_at          timestamptz NOT NULL DEFAULT now(),
  disconnected_at       timestamptz
);

CREATE INDEX IF NOT EXISTS whatsapp_connections_user_idx
  ON whatsapp_connections(user_id);

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "whatsapp_connections_owner" ON whatsapp_connections;
CREATE POLICY "whatsapp_connections_owner" ON whatsapp_connections
  FOR ALL USING (auth.uid() = user_id);

-- ============================================================
-- Deprecation note for whatsapp_sheet_id
-- ============================================================
-- The column user_settings.whatsapp_sheet_id is no longer read by the backend
-- after this migration ships (the Sheet ingestion path is deleted). Left in
-- place to avoid breaking Supabase-generated types and any one-off scripts
-- that may still reference it. Safe to drop in a later migration once we've
-- confirmed nothing else depends on it.

COMMENT ON COLUMN user_settings.whatsapp_sheet_id IS
  'DEPRECATED: legacy Google Sheet ingestion. Replaced by direct DualHook webhook (see whatsapp_connections). Will be dropped in a follow-up migration.';
