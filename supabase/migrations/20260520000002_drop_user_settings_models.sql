-- The classification_model and summary_model columns on user_settings were
-- per-user overrides read by ai-process. As of the previous migration these
-- knobs are super-admin-only and live on smrttask_system_params; ai-process
-- now reads from there. No user has a non-default value set (verified
-- before this migration), so dropping the columns loses no data.

ALTER TABLE user_settings
  DROP COLUMN IF EXISTS classification_model,
  DROP COLUMN IF EXISTS summary_model;
