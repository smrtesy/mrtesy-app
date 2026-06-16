-- ============================================================
-- smrtBot — study / prayer tracking (Phase 2, part 1)
-- ============================================================
-- Two org+bot+phone scoped tables backing the tracking module
-- (server/src/modules/smrtbot/tracking.ts): study sessions (open/close →
-- elapsed minutes) and daily Shacharit prayer reports. Also wires the demo
-- bot's default menu buttons to the tracking actions.

-- 1. study sessions ----------------------------------------------------------
CREATE TABLE smrtbot_study_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  minutes     integer,
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'completed', 'cancelled')),
  source      text NOT NULL DEFAULT 'bot',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_study_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_study_sessions_org_members ON smrtbot_study_sessions
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_study_sessions_touch BEFORE UPDATE ON smrtbot_study_sessions
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_study_sessions_idx ON smrtbot_study_sessions (bot_id, phone, status, started_at);

-- 2. prayers (one Shacharit per day) -----------------------------------------
CREATE TABLE smrtbot_prayers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  prayer_date date NOT NULL,
  started_at  timestamptz,
  ended_at    timestamptz,
  minutes     integer,
  in_minyan   boolean NOT NULL DEFAULT false,
  kind        text NOT NULL DEFAULT 'shacharit',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, phone, prayer_date, kind)
);
ALTER TABLE smrtbot_prayers ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_prayers_org_members ON smrtbot_prayers
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_prayers_touch BEFORE UPDATE ON smrtbot_prayers
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_prayers_idx ON smrtbot_prayers (bot_id, phone, prayer_date);

-- 3. make the demo bot's default menu actionable -----------------------------
-- Point the default menu buttons at the tracking actions, and retire the old
-- informational sub-nodes they used to open (now handled by the actions).
UPDATE smrtbot_menu_nodes n
SET buttons = '[{"id":"study_start","title":"▶️ התחלתי ללמוד"},{"id":"study_end","title":"⏹️ סיימתי"},{"id":"prayer_report","title":"🙏 דיווח שחרית"},{"id":"study_status","title":"📊 הסטטוס שלי"}]'::jsonb
FROM smrtbot_bots b
WHERE n.bot_id = b.id AND b.slug = 'chanoch' AND n.node_key = 'main' AND n.env = 'live';

UPDATE smrtbot_menu_nodes n
SET active = false
FROM smrtbot_bots b
WHERE n.bot_id = b.id AND b.slug = 'chanoch' AND n.env = 'live'
  AND n.node_key IN ('report_prayer', 'my_status', 'period_report');
