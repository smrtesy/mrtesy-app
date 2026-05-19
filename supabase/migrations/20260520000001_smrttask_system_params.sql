-- Rebuild the smrtTask parameters surface around a clear split:
--   • System-wide knobs → new single-row `smrttask_system_params` table,
--     editable only by super-admins, read by ai-process.
--   • Per-user knobs that the user owns (my_emails, office_addresses,
--     skip_senders, skip_recipients) stay on `user_settings`.
--   • Per-user knobs that the super-admin owns (daily_ai_budget_usd)
--     stay on `user_settings` — the admin UI will surface them under
--     /admin/users/[id] in a later commit.
--
-- The 6 columns added by PR #28 (20260519000001_smrttask_parameters)
-- targeted the Express part3/part4 classifiers, which do not run in
-- production (sync_schedules is empty). The live classifier is the
-- Supabase Edge Function `ai-process` and it never read those columns.
-- All users still have the system defaults; dropping costs nothing.

-- ── 1. Drop the unused user_settings columns from PR #28 ───────────────
ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_smrttask_batch_size_check,
  DROP CONSTRAINT IF EXISTS user_settings_whatsapp_lookback_hours_check,
  DROP CONSTRAINT IF EXISTS user_settings_smrttask_rule_threshold_check,
  DROP CONSTRAINT IF EXISTS user_settings_smrttask_project_match_threshold_check,
  DROP CONSTRAINT IF EXISTS user_settings_smrttask_project_cluster_threshold_check;

ALTER TABLE user_settings
  DROP COLUMN IF EXISTS smrttask_classifier_model,
  DROP COLUMN IF EXISTS smrttask_rule_threshold,
  DROP COLUMN IF EXISTS smrttask_project_match_threshold,
  DROP COLUMN IF EXISTS smrttask_project_cluster_threshold,
  DROP COLUMN IF EXISTS smrttask_batch_size,
  DROP COLUMN IF EXISTS whatsapp_lookback_hours;

-- ── 2. New single-row table for system-wide ai-process knobs ──────────
CREATE TABLE IF NOT EXISTS smrttask_system_params (
  id                       text PRIMARY KEY DEFAULT 'smrttask' CHECK (id = 'smrttask'),
  classification_model     text    NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  summary_model            text    NOT NULL DEFAULT 'claude-sonnet-4-6',
  batch_size               integer NOT NULL DEFAULT 40
                                    CHECK (batch_size BETWEEN 1 AND 200),
  processing_lock_minutes  integer NOT NULL DEFAULT 10
                                    CHECK (processing_lock_minutes BETWEEN 1 AND 60),
  calendar_past_days       integer NOT NULL DEFAULT 1
                                    CHECK (calendar_past_days BETWEEN 0 AND 30),
  calendar_future_days     integer NOT NULL DEFAULT 1
                                    CHECK (calendar_future_days BETWEEN 0 AND 365),
  body_truncate_classify   integer NOT NULL DEFAULT 2000
                                    CHECK (body_truncate_classify BETWEEN 200 AND 20000),
  body_truncate_project    integer NOT NULL DEFAULT 500
                                    CHECK (body_truncate_project BETWEEN 100 AND 5000),
  body_truncate_task       integer NOT NULL DEFAULT 6000
                                    CHECK (body_truncate_task BETWEEN 500 AND 20000),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  updated_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE smrttask_system_params IS
  'Single-row system-wide knobs for the ai-process Edge Function. id is fixed to ''smrttask'' so the PRIMARY KEY enforces exactly one row.';

-- Seed the single row with the defaults so callers always find something.
INSERT INTO smrttask_system_params (id) VALUES ('smrttask')
ON CONFLICT (id) DO NOTHING;

-- ── 3. RLS: only super-admins can read or write ───────────────────────
-- The ai-process Edge Function uses the service-role key which bypasses
-- RLS, so this lock-down does not affect runtime classification.
ALTER TABLE smrttask_system_params ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "smrttask_system_params_super_admin_all" ON smrttask_system_params;
CREATE POLICY "smrttask_system_params_super_admin_all" ON smrttask_system_params
  FOR ALL
  USING (auth.uid() IN (SELECT user_id FROM super_admins))
  WITH CHECK (auth.uid() IN (SELECT user_id FROM super_admins));

-- ── 4. Updated-at touch trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_smrttask_system_params_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  IF auth.uid() IS NOT NULL THEN
    NEW.updated_by = auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS smrttask_system_params_touch ON smrttask_system_params;
CREATE TRIGGER smrttask_system_params_touch
  BEFORE UPDATE ON smrttask_system_params
  FOR EACH ROW EXECUTE FUNCTION touch_smrttask_system_params_updated_at();
