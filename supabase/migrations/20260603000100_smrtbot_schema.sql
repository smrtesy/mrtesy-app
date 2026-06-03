-- ============================================================
-- smrtBot — Schema (migrated from botsite)
-- ============================================================
-- All tables org-scoped (org_id) + bot-scoped (bot_id → smrtbot_bots),
-- RLS gated on org_members, uuid PKs. Each table carries `legacy_id`
-- (the original botsite integer id) so the data-migration step can rebuild
-- foreign keys by mapping old int ids → new uuids.
--
-- Source of truth at runtime. Conversation engine reads/writes here.
-- NOT here: contacts (→ smrtCRM), broadcast campaigns (→ smrtReach).

-- ── shared updated_at trigger ────────────────────────────────
CREATE OR REPLACE FUNCTION smrtbot_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

-- ============================================================
-- 1. smrtbot_bots — the bot + its WhatsApp credentials
-- ============================================================
CREATE TABLE smrtbot_bots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legacy_id   integer,
  created_by  uuid REFERENCES auth.users(id),
  name        text NOT NULL,
  slug        text NOT NULL,
  initials    text NOT NULL DEFAULT 'BOT',
  logo_path   text,
  public_phone_number text,
  waba_id     text,
  email_footer_text   text,
  admin_phones text,
  timezone    text NOT NULL DEFAULT 'Asia/Jerusalem',
  active      boolean NOT NULL DEFAULT true,
  -- legacy single-env credentials (kept for back-compat during cutover)
  wa_phone_number_id  text,
  wa_access_token     text,
  verify_token        text,
  -- test environment
  test_wa_phone_number_id text,
  test_wa_access_token    text,
  test_verify_token       text,
  test_phone_display      text,
  -- live environment
  live_wa_phone_number_id text,
  live_wa_access_token    text,
  live_verify_token       text,
  live_phone_display      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
ALTER TABLE smrtbot_bots ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_bots_org_members ON smrtbot_bots
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_bots_touch BEFORE UPDATE ON smrtbot_bots
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_bots_org_idx ON smrtbot_bots (org_id);

-- ============================================================
-- 2. smrtbot_bot_access — per-bot access (permission model ב3)
-- ============================================================
CREATE TABLE smrtbot_bot_access (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, user_id)
);
ALTER TABLE smrtbot_bot_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_bot_access_org_members ON smrtbot_bot_access
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_bot_access_user_idx ON smrtbot_bot_access (user_id);

-- ============================================================
-- 3. smrtbot_wa_users — per-bot WhatsApp conversation users
-- ============================================================
CREATE TABLE smrtbot_wa_users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  phone       text NOT NULL,
  name        text,
  state_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  share_tickets integer NOT NULL DEFAULT 0,
  last_interaction_at timestamptz,
  wa_opted_out        boolean NOT NULL DEFAULT false,
  wa_opted_out_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, phone)
);
ALTER TABLE smrtbot_wa_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_wa_users_org_members ON smrtbot_wa_users
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_wa_users_bot_idx ON smrtbot_wa_users (bot_id, last_interaction_at);

-- ============================================================
-- 4. smrtbot_menu_nodes — conversation menu tree (test/live)
-- ============================================================
CREATE TABLE smrtbot_menu_nodes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  node_key    text NOT NULL,
  type        text NOT NULL DEFAULT 'menu',
  label       text NOT NULL,
  title_he    text,
  body_text   text,
  buttons       jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra_buttons jsonb NOT NULL DEFAULT '[]'::jsonb,
  extra_body  text,
  action      text,
  parent_key  text,
  sort_order  integer NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  category    text NOT NULL DEFAULT 'system',
  image_url   text,
  image_mode  text NOT NULL DEFAULT 'none',
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, node_key, env)
);
ALTER TABLE smrtbot_menu_nodes ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_menu_nodes_org_members ON smrtbot_menu_nodes
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_menu_nodes_touch BEFORE UPDATE ON smrtbot_menu_nodes
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_menu_nodes_bot_env_idx ON smrtbot_menu_nodes (bot_id, env);

-- ============================================================
-- 5. smrtbot_messages — system message templates (test/live)
-- ============================================================
CREATE TABLE smrtbot_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  msg_key     text NOT NULL,
  label       text NOT NULL,
  text        text NOT NULL,
  category    text NOT NULL DEFAULT 'system',
  buttons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_url   text,
  image_mode  text NOT NULL DEFAULT 'none',
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, msg_key, env)
);
ALTER TABLE smrtbot_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_messages_org_members ON smrtbot_messages
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_messages_touch BEFORE UPDATE ON smrtbot_messages
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 6. smrtbot_missions
-- ============================================================
CREATE TABLE smrtbot_missions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  mission_id  text NOT NULL,
  title       text NOT NULL,
  mission_type text NOT NULL DEFAULT 'daily_action',
  content     text,
  option_1    text,
  option_2    text,
  option_3    text,
  correct_option integer,
  reward_diamonds integer NOT NULL DEFAULT 10,
  success_message text,
  related_video_id text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, mission_id, env)
);
ALTER TABLE smrtbot_missions ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_missions_org_members ON smrtbot_missions
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_missions_touch BEFORE UPDATE ON smrtbot_missions
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_missions_bot_env_idx ON smrtbot_missions (bot_id, env);

-- ============================================================
-- 7. smrtbot_trivia
-- ============================================================
CREATE TABLE smrtbot_trivia (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  video_id    text NOT NULL,
  level       text NOT NULL DEFAULT 'easy',
  question    text NOT NULL,
  option_1    text NOT NULL,
  option_2    text NOT NULL,
  option_3    text,
  correct_option integer NOT NULL DEFAULT 1,
  source      text,
  active      boolean NOT NULL DEFAULT true,
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_trivia ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_trivia_org_members ON smrtbot_trivia
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_trivia_touch BEFORE UPDATE ON smrtbot_trivia
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_trivia_bot_env_idx ON smrtbot_trivia (bot_id, env);

-- ============================================================
-- 8. smrtbot_raffles
-- ============================================================
CREATE TABLE smrtbot_raffles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  raffle_date date,
  hebrew_date text DEFAULT '',
  status      text NOT NULL DEFAULT 'Pending',
  raffle_type text NOT NULL DEFAULT 'Diamonds',
  winner_child_id text DEFAULT '',
  coupon_code text DEFAULT '',
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_raffles ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_raffles_org_members ON smrtbot_raffles
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_raffles_touch BEFORE UPDATE ON smrtbot_raffles
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 9. smrtbot_coupons
-- ============================================================
CREATE TABLE smrtbot_coupons (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  coupon_code text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'available',
  raffle_type text DEFAULT 'Diamonds',
  winner_child_id text,
  won_at      timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, coupon_code)
);
ALTER TABLE smrtbot_coupons ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_coupons_org_members ON smrtbot_coupons
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_coupons_touch BEFORE UPDATE ON smrtbot_coupons
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 10. smrtbot_children — game players
-- ============================================================
CREATE TABLE smrtbot_children (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  child_id    text NOT NULL,
  phone       text,
  child_name  text NOT NULL DEFAULT '',
  hebrew_birthday text NOT NULL DEFAULT '',
  reminder_time text NOT NULL DEFAULT '17:00',
  diamonds    integer NOT NULL DEFAULT 0,
  completed_items text NOT NULL DEFAULT '',
  active_reminders boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, child_id)
);
ALTER TABLE smrtbot_children ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_children_org_members ON smrtbot_children
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_children_touch BEFORE UPDATE ON smrtbot_children
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_children_bot_phone_idx ON smrtbot_children (bot_id, phone);

-- ============================================================
-- 11. smrtbot_diamonds_log
-- ============================================================
CREATE TABLE smrtbot_diamonds_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text,
  child_id    text,
  action_type text,
  item_id     text,
  diamonds_change integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_diamonds_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_diamonds_log_org_members ON smrtbot_diamonds_log
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_diamonds_log_child_idx ON smrtbot_diamonds_log (bot_id, child_id);

-- ============================================================
-- 12. smrtbot_knowledge_base — FAQ
-- ============================================================
CREATE TABLE smrtbot_knowledge_base (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  category    text DEFAULT 'general',
  question_pattern text NOT NULL,
  question    text,
  keywords    text,
  answer      text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  sort_order  integer NOT NULL DEFAULT 0,
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_knowledge_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_knowledge_base_org_members ON smrtbot_knowledge_base
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_knowledge_base_touch BEFORE UPDATE ON smrtbot_knowledge_base
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 13. smrtbot_auto_messages
-- ============================================================
CREATE TABLE smrtbot_auto_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  name        text NOT NULL,
  msg_type    text NOT NULL DEFAULT 'Text',
  wait_time   integer NOT NULL DEFAULT 10,
  unit        text NOT NULL DEFAULT 'Minutes',
  content     text NOT NULL,
  media_url   text,
  active      boolean NOT NULL DEFAULT true,
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_auto_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_auto_messages_org_members ON smrtbot_auto_messages
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_auto_messages_touch BEFORE UPDATE ON smrtbot_auto_messages
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 14. smrtbot_holidays
-- ============================================================
CREATE TABLE smrtbot_holidays (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  holiday_name text NOT NULL,
  holiday_group text DEFAULT 'חגי השנה',
  hebrew_date text,
  start_date  date,
  end_date    date,
  active      boolean NOT NULL DEFAULT true,
  display_emoji text DEFAULT '📅',
  sort_order  integer NOT NULL DEFAULT 0,
  notes       text,
  env         text NOT NULL DEFAULT 'test',
  version     integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_holidays ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_holidays_org_members ON smrtbot_holidays
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_holidays_touch BEFORE UPDATE ON smrtbot_holidays
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 15. smrtbot_settings — per-bot key/value config
-- ============================================================
CREATE TABLE smrtbot_settings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  key         text NOT NULL,
  value       text NOT NULL DEFAULT '',
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, key)
);
ALTER TABLE smrtbot_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_settings_org_members ON smrtbot_settings
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_settings_touch BEFORE UPDATE ON smrtbot_settings
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 16. smrtbot_scheduled_configs — inactivity-triggered messages
-- ============================================================
CREATE TABLE smrtbot_scheduled_configs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  inactivity_minutes integer NOT NULL DEFAULT 5,
  send_after_minutes integer NOT NULL DEFAULT 10,
  body_text   text NOT NULL DEFAULT '',
  buttons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  image_url   text,
  env         text NOT NULL DEFAULT 'test',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_scheduled_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_scheduled_configs_org_members ON smrtbot_scheduled_configs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_scheduled_configs_touch BEFORE UPDATE ON smrtbot_scheduled_configs
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();

-- ============================================================
-- 17. smrtbot_scheduled_logs
-- ============================================================
CREATE TABLE smrtbot_scheduled_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  config_id   uuid REFERENCES smrtbot_scheduled_configs(id) ON DELETE CASCADE,
  phone       text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  last_interaction_at timestamptz
);
ALTER TABLE smrtbot_scheduled_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_scheduled_logs_org_members ON smrtbot_scheduled_logs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_scheduled_logs_bot_idx ON smrtbot_scheduled_logs (bot_id, sent_at);

-- ============================================================
-- 18. smrtbot_questions — Q&A log
-- ============================================================
CREATE TABLE smrtbot_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  phone       text,
  name        text DEFAULT '',
  message_text text DEFAULT '',
  question_type text DEFAULT '',
  bot_reply   text DEFAULT '',
  matched_type text DEFAULT '',
  matched_ids text DEFAULT '',
  needs_human boolean NOT NULL DEFAULT false,
  admin_answer text DEFAULT '',
  send_reply  boolean NOT NULL DEFAULT false,
  reply_sent  boolean NOT NULL DEFAULT false,
  reply_sent_at timestamptz,
  notes       text DEFAULT '',
  status      text NOT NULL DEFAULT 'pending',
  admin_reply text,
  replied_at  timestamptz,
  replied_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_questions_org_members ON smrtbot_questions
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_questions_touch BEFORE UPDATE ON smrtbot_questions
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_questions_bot_idx ON smrtbot_questions (bot_id, needs_human, reply_sent);

-- ============================================================
-- 19. smrtbot_feedback
-- ============================================================
CREATE TABLE smrtbot_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  legacy_id   integer,
  phone       text NOT NULL,
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'new',
  admin_note  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_feedback_org_members ON smrtbot_feedback
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- ============================================================
-- 20. smrtbot_referral_log
-- ============================================================
CREATE TABLE smrtbot_referral_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  referrer_phone text NOT NULL,
  new_phone   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_referral_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_referral_log_org_members ON smrtbot_referral_log
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- ============================================================
-- 21. smrtbot_publish_batches — test→live publish/version history
-- ============================================================
CREATE TABLE smrtbot_publish_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  status      text NOT NULL DEFAULT 'published',
  note        text,
  published_by text,
  tables_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  changes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_publish_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_publish_batches_org_members ON smrtbot_publish_batches
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- ============================================================
-- 22. smrtbot_audit_log
-- ============================================================
CREATE TABLE smrtbot_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  user_email  text,
  action      text,
  entity      text,
  entity_id   text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_audit_log_org_members ON smrtbot_audit_log
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_audit_log_bot_idx ON smrtbot_audit_log (bot_id, created_at);

-- ============================================================
-- 23. smrtbot_videos — video index (source of truth at runtime)
-- Populated by CSV import now; future = sync from Maor website API.
-- bot_id nullable: an org-wide library, optionally scoped per bot.
-- ============================================================
CREATE TABLE smrtbot_videos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  vd_id       text,
  vd_internal_id text,
  video_name  text,
  video_number text,
  video_link  text,
  full_url    text,
  display_link text,
  vd_categories text,
  main_category text,
  sub_category text,
  rebbe       text,
  holidays    text,
  icon        text,
  icon_source text,
  search_text text,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  synced_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, vd_id)
);
ALTER TABLE smrtbot_videos ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_videos_org_members ON smrtbot_videos
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE TRIGGER smrtbot_videos_touch BEFORE UPDATE ON smrtbot_videos
  FOR EACH ROW EXECUTE FUNCTION smrtbot_touch_updated_at();
CREATE INDEX smrtbot_videos_cat_idx ON smrtbot_videos (org_id, main_category, sub_category);

-- ============================================================
-- 24. smrtbot_bot_logs — message stream (runtime; retention applied separately)
-- ============================================================
CREATE TABLE smrtbot_bot_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bot_id      uuid NOT NULL REFERENCES smrtbot_bots(id) ON DELETE CASCADE,
  phone       text,
  direction   text,
  env         text DEFAULT 'live',
  node_key    text,
  message_type text,
  body        text,
  is_error    boolean NOT NULL DEFAULT false,
  error_reason text,
  error_context jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE smrtbot_bot_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY smrtbot_bot_logs_org_members ON smrtbot_bot_logs
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX smrtbot_bot_logs_bot_created_idx ON smrtbot_bot_logs (bot_id, created_at);
CREATE INDEX smrtbot_bot_logs_err_idx ON smrtbot_bot_logs (bot_id, is_error);
