-- ============================================================
-- smrtVoice — Seed Dictionaries (helper function, per-org)
-- ============================================================
-- Migrations can't know org_ids ahead of time, so this only creates
-- the helper function. Call it once per org as part of enabling
-- smrtVoice for that org:
--
--   SELECT smrtvoice_seed_default_dictionaries('<org_uuid>', '<user_uuid>');

CREATE OR REPLACE FUNCTION smrtvoice_seed_default_dictionaries(
  target_org_id  uuid,
  target_user_id uuid
)
RETURNS void AS $$
BEGIN
  -- Theophilic / diminutive Hebrew names
  INSERT INTO smrtvoice_pronunciation_lexicon
    (org_id, created_by, original_word, pronounced_as, category)
  VALUES
    (target_org_id, target_user_id, 'שרהלה',    'שָׂרָלֶה',     'theophilic_name'),
    (target_org_id, target_user_id, 'חוהלה',    'חַוָּלֶה',     'theophilic_name'),
    (target_org_id, target_user_id, 'מנדלה',    'מֶנְדֶלֶה',     'theophilic_name'),
    (target_org_id, target_user_id, 'דובילה',   'דּוּבִּילֶה',   'theophilic_name'),
    (target_org_id, target_user_id, 'שרהל''ה',  'שָׂרָלֶה',     'theophilic_name'),
    (target_org_id, target_user_id, 'חוה''לה',  'חַוָּלֶה',     'theophilic_name'),
    (target_org_id, target_user_id, 'מנדל''ה',  'מֶנְדֶלֶה',     'theophilic_name'),
    (target_org_id, target_user_id, 'דובי''לה', 'דּוּבִּילֶה',   'theophilic_name')
  ON CONFLICT (org_id, original_word) DO NOTHING;

  -- Chabad vocabulary
  INSERT INTO smrtvoice_pronunciation_lexicon
    (org_id, created_by, original_word, pronounced_as, category)
  VALUES
    (target_org_id, target_user_id, 'התקשרות',     'הִתְקַשְּׁרוּת',   'chabad'),
    (target_org_id, target_user_id, 'ביטול',       'בִּיטּוּל',        'chabad'),
    (target_org_id, target_user_id, 'מסירות נפש',  'מְסִירוּת נֶפֶשׁ',  'chabad'),
    (target_org_id, target_user_id, 'אהבת ישראל',  'אַהֲבַת יִשְׂרָאֵל','chabad'),
    (target_org_id, target_user_id, 'בעל תשובה',   'בַּעַל תְּשׁוּבָה', 'chabad'),
    (target_org_id, target_user_id, 'אחדות',       'אַחְדוּת',         'chabad'),
    (target_org_id, target_user_id, 'התבוננות',    'הִתְבּוֹנְנוּת',    'chabad'),
    (target_org_id, target_user_id, 'מבצעים',      'מִבְצָעִים',       'chabad'),
    (target_org_id, target_user_id, 'מצוות',       'מִצְווֹת',         'chabad'),
    (target_org_id, target_user_id, 'תניא',        'תַּנְיָא',         'chabad'),
    (target_org_id, target_user_id, 'שיחה',        'שִׂיחָה',         'chabad'),
    (target_org_id, target_user_id, 'שיחות',       'שִׂיחוֹת',         'chabad')
  ON CONFLICT (org_id, original_word) DO NOTHING;

  -- Default settings row for the org
  INSERT INTO smrtvoice_settings (org_id)
  VALUES (target_org_id)
  ON CONFLICT (org_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
