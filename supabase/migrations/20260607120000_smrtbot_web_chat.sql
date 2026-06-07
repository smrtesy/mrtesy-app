-- ============================================================
-- smrtBot — Web Chat channel
-- ============================================================
-- Adds a browser-based chat channel that reuses the existing conversation
-- engine (menu tree / FAQ / games / videos). The engine is transport-agnostic
-- via the new BotChannel abstraction (server/src/modules/smrtbot/channel.ts):
-- the WhatsApp channel sends via Meta, the Web channel persists messages here
-- and broadcasts them over Supabase Realtime to the visitor's session topic.
--
-- Security model: anonymous website visitors NEVER read these tables directly.
-- Each session holds a high-entropy `session_token` (the secret the browser
-- keeps). Realtime delivery is via a Broadcast topic derived from that token,
-- and message history is fetched through the secret-guarded public API — so
-- RLS here is the usual org_members gate (admins viewing conversations); the
-- engine writes with the service role, which bypasses RLS.

-- ── 1. smrtbot_bots — web channel config ─────────────────────
ALTER TABLE smrtbot_bots
  ADD COLUMN IF NOT EXISTS web_enabled         boolean NOT NULL DEFAULT false,
  -- Which env the web channel reads its menu/messages/FAQ from. Web visitors
  -- always see the published experience, so default to 'live'.
  ADD COLUMN IF NOT EXISTS web_env             text    NOT NULL DEFAULT 'live',
  -- CORS allowlist for the embeddable widget. Empty array = allow any origin
  -- (useful while testing); populate with the customer's site origins for prod.
  ADD COLUMN IF NOT EXISTS web_allowed_origins text[]  NOT NULL DEFAULT '{}'::text[],
  -- Optional override copy shown before the conversation starts.
  ADD COLUMN IF NOT EXISTS web_greeting        text,
  -- Cosmetic: accent color for the widget header/launcher (hex, e.g. #1d4ed8).
  ADD COLUMN IF NOT EXISTS web_accent_color    text;

-- ── 2. smrtbot_web_sessions — one per visitor conversation ───
CREATE TABLE IF NOT EXISTS smrtbot_web_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id          uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  -- High-entropy secret the browser holds; also the Realtime topic suffix.
  session_token   text NOT NULL UNIQUE,
  -- The key the engine uses in place of a phone number (smrtbot_wa_users.phone,
  -- smrtbot_bot_logs.phone). Format: 'web:' || id, so web + WhatsApp users never
  -- collide and the existing engine state machine works unchanged.
  participant_key text NOT NULL UNIQUE,
  -- Lead capture (email required, per product decision).
  lead_name       text,
  lead_email      text NOT NULL,
  lead_phone      text,
  origin          text,
  user_agent      text,
  env             text NOT NULL DEFAULT 'live',
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_web_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_web_sessions_org_members ON smrtbot_web_sessions
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtbot_web_sessions_bot_idx
  ON smrtbot_web_sessions (bot_id, last_seen_at);

-- ── 3. smrtbot_web_messages — the conversation stream ────────
CREATE TABLE IF NOT EXISTS smrtbot_web_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES smrtbot_web_sessions(id) ON DELETE CASCADE,
  direction   text NOT NULL,                 -- 'in' | 'out'
  -- 'text' | 'buttons' | 'image' | 'list' — mirrors the WhatsApp message types
  -- the widget must render to give the same experience.
  kind        text NOT NULL DEFAULT 'text',
  body        text NOT NULL DEFAULT '',
  -- Structured extras the UI needs (buttons[], image url + caption, list rows).
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  node_key    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_web_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_web_messages_org_members ON smrtbot_web_messages
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtbot_web_messages_session_idx
  ON smrtbot_web_messages (session_id, created_at);
