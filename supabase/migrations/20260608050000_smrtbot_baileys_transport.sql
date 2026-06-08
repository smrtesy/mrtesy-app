-- ============================================================
-- smrtBot — unofficial WhatsApp transport (Baileys)
-- ============================================================
-- Adds a SECOND WhatsApp transport alongside the official Meta Cloud API.
-- The unofficial transport connects as a real WhatsApp account (WhatsApp-Web
-- protocol via Baileys), can be made admin of a Community / Group, and
-- broadcasts scheduled messages to those groups as part of a marketing plan.
--
-- A bot's `transport` column selects which stack the send-service uses:
--   'meta'    → official Cloud API (wa.ts)              [default, unchanged]
--   'baileys' → unofficial WhatsApp-Web connection      [this migration]
--
-- All tables org-scoped + bot-scoped, RLS gated on org_members (same pattern
-- as the rest of smrtBot). The Railway server uses the service role and
-- bypasses RLS; these policies guard any direct client/PostgREST access.

-- ── 1. transport discriminator on the bot ───────────────────────────────────
ALTER TABLE smrtbot_bots
  ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT 'meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'smrtbot_bots_transport_chk'
  ) THEN
    ALTER TABLE smrtbot_bots
      ADD CONSTRAINT smrtbot_bots_transport_chk
      CHECK (transport IN ('meta', 'baileys'));
  END IF;
END$$;

-- ── 2. smrtbot_wa_auth — Baileys auth-state key/value store ──────────────────
-- Railway's filesystem is ephemeral, so we cannot use useMultiFileAuthState.
-- Each Baileys auth artifact (the `creds` blob + one row per signal key) is
-- persisted here, BufferJSON-serialized into the jsonb `value`. One bot ⇒ one
-- linked device; (bot_id, auth_key) is unique.
CREATE TABLE IF NOT EXISTS smrtbot_wa_auth (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  auth_key    text NOT NULL,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, auth_key)
);
ALTER TABLE smrtbot_wa_auth ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_wa_auth_org_members ON smrtbot_wa_auth
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_wa_auth_bot_idx ON smrtbot_wa_auth (bot_id);

-- ── 3. smrtbot_wa_sessions — connection status + pairing QR (one per bot) ────
CREATE TABLE IF NOT EXISTS smrtbot_wa_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id          uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'closed',
  last_qr         text,             -- data-URL PNG of the latest pairing QR
  connected_phone text,             -- the linked WhatsApp number once paired
  connected_at    timestamptz,
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id),
  CONSTRAINT smrtbot_wa_sessions_status_chk
    CHECK (status IN ('connecting', 'qr', 'open', 'closed'))
);
ALTER TABLE smrtbot_wa_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_wa_sessions_org_members ON smrtbot_wa_sessions
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- ── 4. smrtbot_wa_groups — groups/communities the bot participates in ────────
CREATE TABLE IF NOT EXISTS smrtbot_wa_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id             uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  group_jid          text NOT NULL,
  subject            text NOT NULL DEFAULT '',
  is_community       boolean NOT NULL DEFAULT false,
  is_admin           boolean NOT NULL DEFAULT false,   -- is the bot an admin here
  participants_count integer NOT NULL DEFAULT 0,
  last_synced_at     timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, group_jid)
);
ALTER TABLE smrtbot_wa_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_wa_groups_org_members ON smrtbot_wa_groups
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_wa_groups_bot_idx ON smrtbot_wa_groups (bot_id);

-- ── 5. smrtbot_scheduled_broadcasts — the scheduled-send queue ───────────────
-- A pg_cron job (POST /api/bot/jobs/broadcasts) drains rows whose scheduled_at
-- has passed. `source` records who created the row: a human ('manual'), a
-- smrtReach campaign, or a smrtPlan marketing-plan task.
CREATE TABLE IF NOT EXISTS smrtbot_scheduled_broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id        uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  target_type   text NOT NULL DEFAULT 'group',
  target_jid    text NOT NULL,           -- group JID (…@g.us) or phone JID
  body_text     text NOT NULL DEFAULT '',
  media_url     text,
  scheduled_at  timestamptz NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  sent_at       timestamptz,
  error         text,
  wa_message_id text,
  source        text NOT NULL DEFAULT 'manual',
  source_ref    text,                    -- campaign id / plan task id, etc.
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT smrtbot_broadcasts_target_chk CHECK (target_type IN ('group', 'phone')),
  CONSTRAINT smrtbot_broadcasts_status_chk CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'canceled')),
  CONSTRAINT smrtbot_broadcasts_source_chk CHECK (source IN ('manual', 'smrtreach', 'smrtplan'))
);
ALTER TABLE smrtbot_scheduled_broadcasts ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_scheduled_broadcasts_org_members ON smrtbot_scheduled_broadcasts
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_scheduled_broadcasts_touch BEFORE UPDATE ON smrtbot_scheduled_broadcasts
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
-- The cron drain queries by (status, scheduled_at).
CREATE INDEX smrtbot_scheduled_broadcasts_due_idx
  ON smrtbot_scheduled_broadcasts (status, scheduled_at);
CREATE INDEX smrtbot_scheduled_broadcasts_bot_idx
  ON smrtbot_scheduled_broadcasts (bot_id, scheduled_at);
