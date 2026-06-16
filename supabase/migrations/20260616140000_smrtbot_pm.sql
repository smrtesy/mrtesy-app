-- ============================================================
-- smrtBot — AI project manager (Phase 2, part 2)
-- ============================================================
-- Per-contact projects + classified entries backing the PM module
-- (server/src/modules/smrtbot/projects.ts). Enabled per number via a
-- phone-route with response_mode = 'ai_pm'.

-- 1. projects ----------------------------------------------------------------
CREATE TABLE smrtbot_pm_projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  name        text NOT NULL,
  description text,
  parent_id   uuid REFERENCES smrtbot_pm_projects(id) ON DELETE SET NULL,
  keywords    text,
  entry_count integer NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_pm_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_pm_projects_org_members ON smrtbot_pm_projects
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_pm_projects_touch BEFORE UPDATE ON smrtbot_pm_projects
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_pm_projects_idx ON smrtbot_pm_projects (bot_id, phone, status);

-- 2. entries -----------------------------------------------------------------
CREATE TABLE smrtbot_pm_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  project_id  uuid REFERENCES smrtbot_pm_projects(id) ON DELETE SET NULL,
  type        text,
  summary     text,
  transcript  text,
  source      text NOT NULL DEFAULT 'text',
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'discarded')),
  proposed    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_pm_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_pm_entries_org_members ON smrtbot_pm_entries
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_pm_entries_touch BEFORE UPDATE ON smrtbot_pm_entries
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_pm_entries_idx ON smrtbot_pm_entries (bot_id, phone, status, created_at);

-- 3. allow the new route mode -----------------------------------------------
ALTER TABLE smrtbot_phone_routes DROP CONSTRAINT IF EXISTS smrtbot_phone_routes_response_mode_check;
ALTER TABLE smrtbot_phone_routes ADD CONSTRAINT smrtbot_phone_routes_response_mode_check
  CHECK (response_mode IN ('node', 'reply', 'ai_pm'));

-- 4. switch the demo bot's Chanoch routes to AI-PM + wire its menu -----------
UPDATE smrtbot_phone_routes r
SET response_mode = 'ai_pm'
FROM smrtbot_bots b
WHERE r.bot_id = b.id AND b.slug = 'chanoch' AND r.target_node_key = 'chanoch_main';

UPDATE smrtbot_menu_nodes n
SET buttons = '[{"id":"pm_projects","title":"📂 הפרויקטים שלי"},{"id":"pm_recent","title":"🕒 פריטים אחרונים"},{"id":"chanoch_help","title":"❓ עזרה"}]'::jsonb
FROM smrtbot_bots b
WHERE n.bot_id = b.id AND b.slug = 'chanoch' AND n.node_key = 'chanoch_main' AND n.env = 'live';

UPDATE smrtbot_menu_nodes n
SET active = false
FROM smrtbot_bots b
WHERE n.bot_id = b.id AND b.slug = 'chanoch' AND n.env = 'live'
  AND n.node_key IN ('chanoch_projects', 'chanoch_recent');
