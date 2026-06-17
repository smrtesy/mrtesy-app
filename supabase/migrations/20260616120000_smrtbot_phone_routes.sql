-- ============================================================
-- smrtBot — per-phone-number routing ("different response per number")
-- ============================================================
-- A bot has one default flow (the menu tree / games / FAQ) that every number
-- gets. This adds an override layer: rules keyed by phone / prefix / tag that
-- send a specific number into a different entry node (a different sub-tree) or
-- reply with a fixed canned message. Mirrors the legacy Apps-Script
-- getUserType(phone) → track routing, but managed from the UI.
--
-- Match is comma/newline-separated text (not text[]) so the generic
-- ResourceManager form can edit it as a plain field. Lists of numbers live in
-- one rule; the engine splits on , and newline.

-- 1. routing rules ------------------------------------------------------------
CREATE TABLE smrtbot_phone_routes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id          uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  label           text,
  -- how the rule matches the incoming phone:
  --   phone  → exact number(s)        (e.g. 972500000001)
  --   prefix → starts-with / wildcard (e.g. 972  or  0529*)
  --   tag    → contact carries a tag  (smrtbot_wa_users.tags)
  match_type      text NOT NULL DEFAULT 'phone'
                    CHECK (match_type IN ('phone', 'prefix', 'tag')),
  match_value     text NOT NULL,
  -- what the matched number gets:
  --   node  → enter target_node_key (full menu engine runs, rooted there)
  --   reply → send reply_text (+ reply_buttons) and stop
  response_mode   text NOT NULL DEFAULT 'node'
                    CHECK (response_mode IN ('node', 'reply')),
  target_node_key text,
  reply_text      text,
  reply_buttons   jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority        integer NOT NULL DEFAULT 100,  -- lower = evaluated first
  active          boolean NOT NULL DEFAULT true,
  env             text NOT NULL DEFAULT 'test',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_phone_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_phone_routes_org_members ON smrtbot_phone_routes
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_phone_routes_touch BEFORE UPDATE ON smrtbot_phone_routes
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_phone_routes_lookup_idx
  ON smrtbot_phone_routes (bot_id, env, active, priority);

-- 2. contact tags (for match_type = 'tag') -----------------------------------
-- Comma/newline-separated tags on a conversation contact, editable from the
-- new "contacts" tab. The engine splits these and intersects with a tag rule.
ALTER TABLE smrtbot_wa_users ADD COLUMN IF NOT EXISTS tags text;
