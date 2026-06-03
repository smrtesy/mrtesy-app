-- ============================================================
-- smrtReach — App Registration
-- ============================================================
-- Adds the app to the platform registry so requireApp("smrtreach")
-- can resolve it, and app_memberships rows can be inserted per org.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtreach',
  'smrtReach',
  'Multi-channel outreach (WhatsApp + email) over audiences from smrtCRM'
)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_status'
  ) THEN
    INSERT INTO app_status (app_slug, stage, summary)
    VALUES (
      'smrtreach',
      'בניה',
      'דיוור רב-ערוצי — יסוד: קמפיינים, פתרון קהל מ-smrtCRM, תבניות, תצוגת נמענים, unsubscribe. שליחת SES/וואטסאפ ממתינה לסודות SES ו-smrtBot.'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
