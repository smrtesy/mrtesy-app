-- ============================================================
-- smrtBot — per-env App Secret stored in Vault
-- ============================================================
-- A bot's live and test phone numbers can belong to different Meta apps with
-- different App Secrets. Store each separately as a Vault secret pointer so the
-- webhook can verify X-Hub-Signature-256 against the right one (and both can be
-- enforced at once). The legacy plaintext `app_secret` column stays as a
-- fallback verification candidate for back-compat.
ALTER TABLE smrtbot_bots
  ADD COLUMN IF NOT EXISTS live_app_secret_id uuid,
  ADD COLUMN IF NOT EXISTS test_app_secret_id uuid;
