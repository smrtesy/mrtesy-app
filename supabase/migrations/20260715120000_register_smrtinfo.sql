-- ============================================================
-- smrtInfo — App Registration
-- ============================================================
-- Adds the app to the platform registry so requireApp("smrtinfo") can resolve
-- it, and app_memberships rows can be inserted per org. Mirrors
-- 20260713100000_register_smrtvault.sql.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtinfo',
  'smrtInfo',
  'Information center: extracts facts from the ingest stream (email/WhatsApp/Drive/calendar/SMS) into a searchable, personal- and org-scoped knowledge base, and answers free-text questions with sourced deep links. Detected passwords are routed to smrtVault by suggestion, never stored here.'
)
ON CONFLICT (slug) DO NOTHING;

-- Initial status row for the admin dashboard. Optional — only insert if the
-- app_status table exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_status'
  ) THEN
    INSERT INTO app_status (app_slug, stage, summary)
    VALUES (
      'smrtinfo',
      'בניה',
      'מרכז מידע: חילוץ עובדות מכל הערוצים למאגר מחופש (אישי + ארגוני) ומענה על שאלות חופשיות עם מקור וקישור ישיר. יסוד: סכמה + רישום אפליקציה.'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
