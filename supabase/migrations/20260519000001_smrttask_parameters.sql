-- Exposes the smrtTask classifier knobs (model, thresholds, batch size) and the
-- WhatsApp lookback window as per-user settings so the admin settings page can
-- manage them. Each column is nullable with a default that matches the value
-- previously hardcoded in server/src/modules/smrttask/parts/* so existing users
-- see no behaviour change until they pick a non-default.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS smrttask_classifier_model          text,
  ADD COLUMN IF NOT EXISTS smrttask_rule_threshold            numeric(4,3) DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS smrttask_project_match_threshold   numeric(4,3) DEFAULT 0.7,
  ADD COLUMN IF NOT EXISTS smrttask_project_cluster_threshold numeric(4,3) DEFAULT 0.65,
  ADD COLUMN IF NOT EXISTS smrttask_batch_size                integer DEFAULT 5,
  ADD COLUMN IF NOT EXISTS whatsapp_lookback_hours            integer DEFAULT 48;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_smrttask_batch_size_check') THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_smrttask_batch_size_check
      CHECK (smrttask_batch_size IS NULL OR smrttask_batch_size BETWEEN 1 AND 50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_whatsapp_lookback_hours_check') THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_whatsapp_lookback_hours_check
      CHECK (whatsapp_lookback_hours IS NULL OR whatsapp_lookback_hours BETWEEN 1 AND 720);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_smrttask_rule_threshold_check') THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_smrttask_rule_threshold_check
      CHECK (smrttask_rule_threshold IS NULL OR smrttask_rule_threshold BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_smrttask_project_match_threshold_check') THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_smrttask_project_match_threshold_check
      CHECK (smrttask_project_match_threshold IS NULL OR smrttask_project_match_threshold BETWEEN 0 AND 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_smrttask_project_cluster_threshold_check') THEN
    ALTER TABLE user_settings
      ADD CONSTRAINT user_settings_smrttask_project_cluster_threshold_check
      CHECK (smrttask_project_cluster_threshold IS NULL OR smrttask_project_cluster_threshold BETWEEN 0 AND 1);
  END IF;
END $$;

COMMENT ON COLUMN user_settings.smrttask_classifier_model          IS 'Override the Anthropic model used by Part 3. NULL = claude-sonnet-4-6.';
COMMENT ON COLUMN user_settings.smrttask_rule_threshold            IS 'Min confidence for Part 3 to insert a suggested rule into rules_memory. NULL = 0.7.';
COMMENT ON COLUMN user_settings.smrttask_project_match_threshold   IS 'Min project_confidence for Part 3 to link a task to an existing project. NULL = 0.7.';
COMMENT ON COLUMN user_settings.smrttask_project_cluster_threshold IS 'Min confidence for Part 4/suggest to surface a project cluster. NULL = 0.65.';
COMMENT ON COLUMN user_settings.smrttask_batch_size                IS 'How many source_messages Part 3 processes between run_session checkpoints. NULL = 5.';
COMMENT ON COLUMN user_settings.whatsapp_lookback_hours            IS 'How far back Part 2 looks each run (hours). NULL = 48.';
