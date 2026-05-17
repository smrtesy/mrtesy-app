-- Add app_slug to rules_memory and sync_schedules so that per-app settings
-- pages can scope their queries without mixing data across future apps.
-- All existing rows get DEFAULT 'smrttask' (the only app today).

ALTER TABLE rules_memory
  ADD COLUMN IF NOT EXISTS app_slug TEXT NOT NULL DEFAULT 'smrttask';

CREATE INDEX IF NOT EXISTS rules_memory_app_slug_idx
  ON rules_memory(user_id, app_slug);

ALTER TABLE sync_schedules
  ADD COLUMN IF NOT EXISTS app_slug TEXT NOT NULL DEFAULT 'smrttask';

-- Replace UNIQUE(user_id, part) with UNIQUE(user_id, app_slug, part)
-- so each app can independently manage its own sync schedule per part.
ALTER TABLE sync_schedules
  DROP CONSTRAINT IF EXISTS sync_schedules_user_id_part_key;

ALTER TABLE sync_schedules
  ADD CONSTRAINT sync_schedules_user_app_part_key
  UNIQUE (user_id, app_slug, part);

CREATE INDEX IF NOT EXISTS sync_schedules_app_slug_idx
  ON sync_schedules(user_id, app_slug);

-- run_sessions: same scoping so the sync page history stays per-app.
-- Backend must pass app_slug when inserting; existing rows default to 'smrttask'.
ALTER TABLE run_sessions
  ADD COLUMN IF NOT EXISTS app_slug TEXT NOT NULL DEFAULT 'smrttask';

CREATE INDEX IF NOT EXISTS run_sessions_app_slug_idx
  ON run_sessions(user_id, app_slug);
