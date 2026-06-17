-- ============================================================
-- smrtTask — selective WhatsApp auto-reply (per-user, Coexistence-safe)
-- ============================================================
-- The personal number is connected to smrtTask via Coexistence: the webhook
-- ingests messages but never replies. This adds an OPT-IN, allowlist-only
-- auto-reply layer scoped to the connection owner (user_id). Default is
-- silent: no rule matches → no reply. A master switch on the connection
-- (autoreply_enabled, default false) gates all sending so nothing goes out to
-- real contacts until the user explicitly turns it on.

-- 1. master switch -----------------------------------------------------------
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS autoreply_enabled boolean NOT NULL DEFAULT false;

-- 2. rules -------------------------------------------------------------------
CREATE TABLE whatsapp_autoreply_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label           text,
  -- how the rule matches the inbound sender:
  --   phone   → exact number(s)            (match_value, comma/newline sep)
  --   prefix  → starts-with / wildcard
  --   tag     → sender carries a tag       (whatsapp_contact_tags)
  --   known   → sender has prior history / is in CRM  (match_value unused)
  --   unknown → first-time / stranger      (match_value unused)
  match_type      text NOT NULL DEFAULT 'phone'
                    CHECK (match_type IN ('phone', 'prefix', 'tag', 'known', 'unknown')),
  match_value     text,
  response_mode   text NOT NULL DEFAULT 'reply'
                    CHECK (response_mode IN ('reply', 'ai')),
  reply_text      text,
  reply_buttons   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_instructions text,
  priority        integer NOT NULL DEFAULT 100,  -- lower = evaluated first
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE whatsapp_autoreply_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_autoreply_rules_owner ON whatsapp_autoreply_rules
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER whatsapp_autoreply_rules_touch BEFORE UPDATE ON whatsapp_autoreply_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX whatsapp_autoreply_rules_idx ON whatsapp_autoreply_rules (user_id, active, priority);

-- 3. contact tags (for match_type = 'tag') -----------------------------------
CREATE TABLE whatsapp_contact_tags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  tags        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, phone)
);
ALTER TABLE whatsapp_contact_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_contact_tags_owner ON whatsapp_contact_tags
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE TRIGGER whatsapp_contact_tags_touch BEFORE UPDATE ON whatsapp_contact_tags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
