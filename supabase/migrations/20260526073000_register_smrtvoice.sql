-- ============================================================
-- smrtVoice — App Registration
-- ============================================================
-- Adds the app to the platform registry so requireApp("smrtvoice")
-- can resolve it, and app_memberships rows can be inserted per org.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtvoice',
  'smrtVoice',
  'AI voice generation for video scripts using Resemble and Chatterbox'
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
      'smrtvoice',
      'בניה',
      'אפליקציית הקראת סקריפטים — שלב פיתוח ראשוני (MVP skeleton)'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
