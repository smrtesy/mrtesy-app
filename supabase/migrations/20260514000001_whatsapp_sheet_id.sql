-- Adds per-user WhatsApp Sheet ID so each tenant routes PART 2 to their
-- own Sheet instead of the operator's env-configured global one. The env
-- WHATSAPP_SHEET_ID remains as a final fallback (e.g. for migration of
-- existing single-tenant deployments) — see server/src/parts/part2-whatsapp.ts.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS whatsapp_sheet_id text;

COMMENT ON COLUMN user_settings.whatsapp_sheet_id IS
  'Per-user Google Sheet ID feeding the WhatsApp ingest pipeline. NULL means use the env-default; set during onboarding step 3.';
