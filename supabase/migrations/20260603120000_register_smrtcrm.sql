-- ============================================================
-- smrtCRM — App Registration
-- ============================================================
-- Adds the app to the platform registry so requireApp("smrtcrm")
-- can resolve it, and app_memberships rows can be inserted per org.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtcrm',
  'smrtCRM',
  'Org-wide contact management: contacts, tags, groups and segments, fed by smrtBot and CSV import'
)
ON CONFLICT (slug) DO NOTHING;

-- Initial status row for the admin dashboard. Optional — only insert if
-- the app_status table exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_status'
  ) THEN
    INSERT INTO app_status (app_slug, stage, summary)
    VALUES (
      'smrtcrm',
      'בניה',
      'ניהול אנשי קשר org-wide — יסוד: אנשי קשר, תגיות, קבוצות, סגמנטים, ייבוא CSV ודה-דופליקציה'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
