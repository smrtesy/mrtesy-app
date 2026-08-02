-- ============================================================
-- smrtDesign — App Registration
-- ============================================================
-- Adds the app to the platform registry so requireApp("smrtdesign")
-- resolves it and app_memberships rows can be inserted per org.
-- smrtDesign generates unique design ideas via the built-in Claude engine,
-- guided by docs/design-process.md (the design method), with a gallery and
-- a pick-from-each remix that outputs an updated combined design.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtdesign',
  'smrtDesign',
  'Generates unique, non-generic design ideas via the built-in Claude engine (guided by the design-process method), with a gallery and pick-from-each remix'
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
      'smrtdesign',
      'בניה',
      'מחולל רעיונות-עיצוב על מנוע-הקלוד-המובנה — שלב בנייה (v1+v2)'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
