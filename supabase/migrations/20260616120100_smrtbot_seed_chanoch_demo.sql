-- ============================================================
-- smrtBot — seed: "בוט חנוך" demo bot (org Maor)
-- ============================================================
-- Reproduces, in the smrtBot model, the content of the Apps-Script bots the
-- user migrated: a DEFAULT study/prayer-tracking menu that every number gets,
-- and a Chanoch AI project-manager menu that a SPECIFIC number is routed to —
-- demonstrating the new per-number routing layer end to end.
--
-- Content only (menus / messages / FAQ / routes). Real phone numbers, WhatsApp
-- credentials and the deep behaviours (session timing, Gemini classification,
-- Hebrew dates) are NOT seeded — phone numbers are placeholders to edit in UI.
--
-- Guarded on the org existing so it is a no-op on other environments.
-- Idempotent: re-running refreshes the same demo bot in place.

DO $$
DECLARE
  v_org     uuid := 'dccf542d-ff50-4232-945b-0b6df7e510dc'; -- Maor
  v_creator uuid := '9cb6086a-2deb-44c1-93b6-93408f4d273c'; -- org owner
  v_bot     uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
    RAISE NOTICE 'org % not found — skipping smrtBot demo seed', v_org;
    RETURN;
  END IF;

  -- Bot ----------------------------------------------------------------------
  INSERT INTO smrtbot_bots (org_id, created_by, name, slug, initials, active, timezone)
  VALUES (v_org, v_creator, 'בוט חנוך — מנהל פרויקטים', 'chanoch', 'חנ', true, 'Asia/Jerusalem')
  ON CONFLICT (org_id, slug) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_bot;

  -- Menu nodes (live env) ----------------------------------------------------
  INSERT INTO smrtbot_menu_nodes
    (org_id, bot_id, node_key, type, label, title_he, body_text, buttons, parent_key, env, category, sort_order, active)
  VALUES
    -- ── DEFAULT flow: study / prayer tracking (every number) ──
    (v_org, v_bot, 'main', 'menu', 'תפריט ראשי', 'שלום 👋',
      '📥 דווח לי על לימוד או תפילה ואעקוב עבורך.' || chr(10) || chr(10) || 'מה תרצה לעשות?',
      '[{"id":"report_prayer","title":"🙏 דיווח שחרית"},{"id":"my_status","title":"📊 הסטטוס שלי היום"},{"id":"period_report","title":"📅 דוח תקופתי"}]'::jsonb,
      NULL, 'live', 'system', 0, true),
    (v_org, v_bot, 'report_prayer', 'menu', 'דיווח שחרית', 'דיווח על שחרית 🙏',
      'כאן מדווחים על תפילת שחרית: שעת התחלה, שעת סיום, ובמניין או ביחידות. הדיווח משמש לסטטיסטיקה.',
      '[{"id":"nav_home","title":"⬅️ תפריט"}]'::jsonb, 'main', 'live', 'system', 1, true),
    (v_org, v_bot, 'my_status', 'menu', 'סטטוס יומי', 'הסטטוס שלי היום 📊',
      'סיכום יומי: כמה למדת מול היעד, סשנים שנרשמו, ודיווח שחרית.',
      '[{"id":"nav_home","title":"⬅️ תפריט"}]'::jsonb, 'main', 'live', 'system', 2, true),
    (v_org, v_bot, 'period_report', 'menu', 'דוח תקופתי', 'דוח תקופתי 📅',
      'דוח על פני התקופה: מצטבר מול יעד, קצב, ואחוז ביצוע ביום המקורי.',
      '[{"id":"nav_home","title":"⬅️ תפריט"}]'::jsonb, 'main', 'live', 'system', 3, true),
    -- ── CHANOCH flow: AI project manager (routed by number/tag) ──
    (v_org, v_bot, 'chanoch_main', 'menu', 'תפריט חנוך', 'שלום חנוך 👋',
      '📥 שלח לי הודעה קולית, טקסט או לינק ואסווג אותו אוטומטית לפרויקט.' || chr(10) || chr(10) || 'מה תרצה לעשות?',
      '[{"id":"chanoch_projects","title":"📂 הפרויקטים שלי"},{"id":"chanoch_recent","title":"🕒 פריטים אחרונים"},{"id":"chanoch_help","title":"❓ עזרה"}]'::jsonb,
      NULL, 'live', 'system', 10, true),
    (v_org, v_bot, 'chanoch_projects', 'menu', 'פרויקטים', 'הפרויקטים שלי 📂',
      'כאן תראה את רשימת הפרויקטים ותת-הפרויקטים שלך, עם הידע שנצבר בכל אחד.',
      '[{"id":"nav_home","title":"⬅️ תפריט"}]'::jsonb, 'chanoch_main', 'live', 'system', 11, true),
    (v_org, v_bot, 'chanoch_recent', 'menu', 'פריטים אחרונים', 'פריטים אחרונים 🕒',
      'עשרת הפריטים האחרונים שנשמרו, לפי תאריך.',
      '[{"id":"nav_home","title":"⬅️ תפריט"}]'::jsonb, 'chanoch_main', 'live', 'system', 12, true),
    (v_org, v_bot, 'chanoch_help', 'menu', 'עזרה חנוך', 'איך אני עובד? 📖',
      'שלח מידע (קול/טקסט/לינק) ואסווג אותו לפרויקט. לפני כל שמירה תאשר, תתקן או תדחה. אפשר גם לנהל פרויקטים, תת-פרויקטים ומשימות בשפה חופשית.',
      '[{"id":"nav_home","title":"⬅️ תפריט"}]'::jsonb, 'chanoch_main', 'live', 'system', 13, true)
  ON CONFLICT (bot_id, node_key, env) DO UPDATE SET
    type = EXCLUDED.type, label = EXCLUDED.label, title_he = EXCLUDED.title_he,
    body_text = EXCLUDED.body_text, buttons = EXCLUDED.buttons,
    parent_key = EXCLUDED.parent_key, sort_order = EXCLUDED.sort_order, active = EXCLUDED.active;

  -- System messages (live env) ----------------------------------------------
  INSERT INTO smrtbot_messages (org_id, bot_id, msg_key, label, text, env)
  VALUES
    (v_org, v_bot, 'no_results', 'לא הובן', 'לא הבנתי 🤔 נסה שוב או שלח "תפריט" לבחירה מהתפריט.', 'live'),
    (v_org, v_bot, 'more_options', 'עוד אפשרויות', 'עוד אפשרויות:', 'live'),
    (v_org, v_bot, 'list_button', 'כפתור רשימה', 'בחירה', 'live')
  ON CONFLICT (bot_id, msg_key, env) DO UPDATE SET text = EXCLUDED.text;

  -- FAQ / knowledge base (live env) — refresh seed rows in place -------------
  DELETE FROM smrtbot_knowledge_base WHERE bot_id = v_bot AND category = 'seed';
  INSERT INTO smrtbot_knowledge_base
    (org_id, bot_id, question_pattern, keywords, answer, category, active, env, sort_order)
  VALUES
    (v_org, v_bot, 'עזרה איך פקודות מה אתה יכול לעשות', 'עזרה,איך,פקודות,מה',
      'אני עוקב אחרי לימוד ותפילה ומסווג מידע לפרויקטים. שלח "תפריט" לאפשרויות, או דווח בחופשי.', 'seed', true, 'live', 0),
    (v_org, v_bot, 'לימוד סשן התחלתי סיימתי זמן', 'לימוד,סשן,התחלתי,סיימתי',
      'לתיעוד לימוד: שלח "התחלתי" כשאתה מתחיל ו"סיימתי" כשסיימת — אחשב את הזמן אוטומטית.', 'seed', true, 'live', 1),
    (v_org, v_bot, 'פרויקט פרויקטים סיווג מידע הקלטה', 'פרויקט,סיווג,מידע,הקלטה',
      'שלח הודעה קולית/טקסט/לינק ואסווג אותו לפרויקט המתאים. לפני שמירה תקבל אישור.', 'seed', true, 'live', 2);

  -- Per-number routes (live env) — refresh in place --------------------------
  DELETE FROM smrtbot_phone_routes WHERE bot_id = v_bot AND env = 'live';
  INSERT INTO smrtbot_phone_routes
    (org_id, bot_id, label, match_type, match_value, response_mode, target_node_key, reply_text, priority, active, env)
  VALUES
    (v_org, v_bot, 'חנוך — מנהל פרויקטים (AI)', 'phone', '972500000001', 'node', 'chanoch_main', NULL, 10, true, 'live'),
    (v_org, v_bot, 'VIP (לפי תגית)', 'tag', 'vip', 'node', 'chanoch_main', NULL, 20, true, 'live'),
    (v_org, v_bot, 'חיוג מחו"ל (קידומת)', 'prefix', '1', 'node', 'main', NULL, 80, true, 'live'),
    (v_org, v_bot, 'מספר חסום (דוגמה לתשובה קבועה)', 'phone', '972500000099', 'reply', NULL,
      'מצטערים, השירות אינו זמין עבור מספר זה.', 90, true, 'live');

  -- Sample tagged contact (so the VIP tag rule has something to match) -------
  INSERT INTO smrtbot_wa_users (org_id, bot_id, phone, name, tags)
  VALUES (v_org, v_bot, '972500000002', 'איש קשר VIP לדוגמה', 'vip')
  ON CONFLICT (bot_id, phone) DO UPDATE SET tags = EXCLUDED.tags, name = EXCLUDED.name;
END $$;
