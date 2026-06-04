-- ============================================================
-- smrtPlan — App Registration
-- ============================================================
-- Adds smrtPlan to the platform registry so requireApp("smrtplan") can
-- resolve it and app_memberships rows can be inserted per org.
--
-- smrtPlan is the *planning* layer that sits on top of smrtTask (the
-- *execution* layer): plans, hierarchy, streams, the dependency path, and an
-- engine that schedules backwards from deadlines and releases blocked tasks.
--
-- This does NOT enable the app for any org — until an app_memberships row
-- exists, every smrtPlan route is gated 403 by requireApp, so deploying the
-- code is safe before the schema/data migration is reviewed.

INSERT INTO apps (slug, name, description)
VALUES (
  'smrtplan',
  'smrtPlan',
  'Planning layer over smrtTask — plans, dependency path, backward scheduling engine and Gantt/matrix/repository views'
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
      'smrtplan',
      'בניה',
      'שכבת התכנון מעל smrtTask — סכמה, מנוע תזמון אחורה, ותצוגות גאנט/מטריצה/מאגר'
    )
    ON CONFLICT (app_slug) DO NOTHING;
  END IF;
END$$;
