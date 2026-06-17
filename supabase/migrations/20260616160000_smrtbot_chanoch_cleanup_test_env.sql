-- ============================================================
-- smrtBot — "chanoch" demo bot: diagram cleanup + populate the TEST env
-- ============================================================
-- (1) The default menu's buttons point at tracking ACTIONS (study_start,
--     study_end, prayer_report, study_status) that the engine handles in code,
--     so they had no menu node and showed as "missing" in the diagram. Create
--     real type='action' nodes so they render as linked. (Cosmetic only — the
--     engine intercepts these ids before any node lookup, so behaviour is
--     unchanged.)
-- (2) Delete the deactivated leftover nodes (period_report/my_status/
--     report_prayer) from the first seed.
-- (3) Mirror all live content into the TEST env so the bot has an editable
--     workspace to edit-then-publish from (content was seeded straight to live).
DO $$
DECLARE
  v_bot uuid;
BEGIN
  SELECT b.id INTO v_bot
  FROM smrtbot_bots b JOIN organizations o ON o.id = b.org_id
  WHERE b.slug = 'chanoch' AND o.slug = 'maor'
  LIMIT 1;
  IF v_bot IS NULL THEN
    RAISE NOTICE 'chanoch bot not found — skipping';
    RETURN;
  END IF;

  -- (1) action nodes for the tracking buttons (live)
  INSERT INTO smrtbot_menu_nodes
    (org_id, bot_id, node_key, type, label, title_he, action, parent_key, sort_order, active, category, env)
  SELECT b.org_id, v_bot, x.node_key, 'action', x.label, x.title_he, x.node_key, 'main', x.sort_order, true, 'system', 'live'
  FROM smrtbot_bots b,
    (VALUES
      ('study_start',  'התחלתי ללמוד', '▶️ התחלתי ללמוד', 1),
      ('study_end',    'סיימתי',       '⏹️ סיימתי',       2),
      ('prayer_report','דיווח שחרית',  '🙏 דיווח שחרית',  3),
      ('study_status', 'הסטטוס שלי',    '📊 הסטטוס שלי',   4)
    ) AS x(node_key, label, title_he, sort_order)
  WHERE b.id = v_bot
  ON CONFLICT (bot_id, node_key, env) DO UPDATE SET
    type = 'action', action = EXCLUDED.action, parent_key = 'main',
    label = EXCLUDED.label, title_he = EXCLUDED.title_he,
    sort_order = EXCLUDED.sort_order, active = true;

  -- (2) drop the deactivated leftovers
  DELETE FROM smrtbot_menu_nodes
  WHERE bot_id = v_bot AND node_key IN ('period_report', 'my_status', 'report_prayer');

  -- (3) mirror live → test (test was empty; replace it with a clean copy)
  DELETE FROM smrtbot_menu_nodes WHERE bot_id = v_bot AND env = 'test';
  INSERT INTO smrtbot_menu_nodes
    (org_id, bot_id, node_key, type, label, title_he, body_text, buttons, extra_buttons,
     action, parent_key, sort_order, active, category, image_url, image_mode, button_layout, env)
  SELECT org_id, bot_id, node_key, type, label, title_he, body_text, buttons, extra_buttons,
         action, parent_key, sort_order, active, category, image_url, image_mode, button_layout, 'test'
  FROM smrtbot_menu_nodes WHERE bot_id = v_bot AND env = 'live';

  DELETE FROM smrtbot_messages WHERE bot_id = v_bot AND env = 'test';
  INSERT INTO smrtbot_messages (org_id, bot_id, msg_key, label, text, category, buttons, image_url, image_mode, env)
  SELECT org_id, bot_id, msg_key, label, text, category, buttons, image_url, image_mode, 'test'
  FROM smrtbot_messages WHERE bot_id = v_bot AND env = 'live';

  DELETE FROM smrtbot_knowledge_base WHERE bot_id = v_bot AND env = 'test';
  INSERT INTO smrtbot_knowledge_base (org_id, bot_id, question_pattern, question, keywords, answer, category, active, sort_order, notes, env)
  SELECT org_id, bot_id, question_pattern, question, keywords, answer, category, active, sort_order, notes, 'test'
  FROM smrtbot_knowledge_base WHERE bot_id = v_bot AND env = 'live';

  DELETE FROM smrtbot_phone_routes WHERE bot_id = v_bot AND env = 'test';
  INSERT INTO smrtbot_phone_routes (org_id, bot_id, label, match_type, match_value, response_mode, target_node_key, reply_text, reply_buttons, priority, active, env)
  SELECT org_id, bot_id, label, match_type, match_value, response_mode, target_node_key, reply_text, reply_buttons, priority, active, 'test'
  FROM smrtbot_phone_routes WHERE bot_id = v_bot AND env = 'live';
END $$;
