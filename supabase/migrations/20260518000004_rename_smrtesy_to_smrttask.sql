-- Rename the smrtTask app's DB slug from legacy "smrtesy" to "smrttask"
-- to match the new-app-guide convention (slug == lowercase product name).

-- 1. app_status has FK to apps.slug — drop, update both, recreate with ON UPDATE CASCADE
ALTER TABLE app_status DROP CONSTRAINT app_status_app_slug_fkey;

UPDATE apps       SET slug     = 'smrttask' WHERE slug     = 'smrtesy';
UPDATE app_status SET app_slug = 'smrttask' WHERE app_slug = 'smrtesy';

ALTER TABLE app_status
  ADD CONSTRAINT app_status_app_slug_fkey
  FOREIGN KEY (app_slug) REFERENCES apps(slug) ON UPDATE CASCADE ON DELETE CASCADE;

-- 2. Free-text app_slug / source_app / target_app columns (no FK) — flip remaining 'smrtesy' rows
UPDATE rules_memory   SET app_slug   = 'smrttask' WHERE app_slug   = 'smrtesy';
UPDATE sync_schedules SET app_slug   = 'smrttask' WHERE app_slug   = 'smrtesy';
UPDATE run_sessions   SET app_slug   = 'smrttask' WHERE app_slug   = 'smrtesy';
UPDATE notifications  SET app_slug   = 'smrttask' WHERE app_slug   = 'smrtesy';
UPDATE app_events     SET source_app = 'smrttask' WHERE source_app = 'smrtesy';
UPDATE entity_links   SET source_app = 'smrttask' WHERE source_app = 'smrtesy';
UPDATE entity_links   SET target_app = 'smrttask' WHERE target_app = 'smrtesy';
