-- ============================================================
-- smrtBot — App Registration
-- ============================================================
-- Adds smrtBot to the platform registry so requireApp("smrtbot") can
-- resolve it and app_memberships rows can be inserted per org. Migrated
-- from the legacy `botsite` app (WhatsApp conversational engine).
--
-- This does NOT enable the app for any org — until an app_memberships row
-- exists, every smrtBot route is gated 403 by requireApp, so deploying the
-- code is safe before the schema/data migration is reviewed.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtbot',
  'smrtBot',
  'WhatsApp conversational bots — menu, game, FAQ and video engine (migrated from botsite)'
)
ON CONFLICT (slug) DO NOTHING;

-- Initial status row for the admin dashboard (only if app_status exists).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_status'
  ) THEN
    INSERT INTO app_status (app_slug, stage, summary)
    VALUES (
      'smrtbot',
      'בניה',
      'הגירת botsite לפלטפורמה — שלב scaffolding (רישום אפליקציה, מודול שרת)'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
