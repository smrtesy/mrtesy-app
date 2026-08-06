-- Security-hardening plan §5.1, step 2a (ADDITIVE / reversible).
--
-- Goal of step 2: the Google OAuth tokens in user_credentials.access_token /
-- refresh_token are stored as PLAINTEXT. Move them into Supabase Vault (the
-- mechanism already proven in production for app_secrets / managed_secrets /
-- whatsapp / smrtvault). The existing pgcrypto encrypt_token/decrypt_token were
-- rejected: they depend on a GUC (app.settings.service_role_key) that is NOT set
-- in this database, so they currently return NULL — verified 2026-08-06.
--
-- This migration is the REVERSIBLE foundation only. It does NOT remove or blank
-- any plaintext — both the plaintext columns and the new Vault refs are kept in
-- sync (dual storage), so every existing reader keeps working untouched. Blanking
-- the plaintext at rest is a SEPARATE, data-changing step (2c) that needs explicit
-- approval + a SELECT preview.
--
-- Three pieces:
--   1. Two nullable columns holding the Vault secret ids.
--   2. A BEFORE INSERT/UPDATE trigger that MIRRORS any plaintext token written to
--      the row into Vault (create the secret the first time, update it after),
--      recording the id in the *_secret_id column. It calls vault.create_secret /
--      vault.update_secret DIRECTLY (the trigger is SECURITY DEFINER) rather than
--      the public wrappers, so it works even when the writer is the user-scoped
--      OAuth callback (anon/authenticated role) — the wrappers hard-require
--      service_role and would abort that write.
--   3. A one-time backfill of the existing rows (fills the just-added columns from
--      the existing plaintext; nothing existing is modified or lost).
-- Readers keep reading plaintext for now; the reader cutover to Vault is step 2b
-- (application code), and only after that is verified does 2c blank the plaintext.

-- 1. Vault-ref columns (nullable — a row is valid before its first write mirrors it).
ALTER TABLE public.user_credentials
  ADD COLUMN IF NOT EXISTS access_token_secret_id  uuid,
  ADD COLUMN IF NOT EXISTS refresh_token_secret_id uuid;

COMMENT ON COLUMN public.user_credentials.access_token_secret_id IS
  'Supabase Vault secret id holding the access_token (security plan §5.1). The '
  'plaintext access_token column is kept in sync until step 2c blanks it.';
COMMENT ON COLUMN public.user_credentials.refresh_token_secret_id IS
  'Supabase Vault secret id holding the refresh_token (security plan §5.1).';

-- 2. Mirror-to-Vault trigger. Only ever mirrors a NON-NULL plaintext, so a writer
--    that does not touch a token (e.g. token-refresh updates only access_token) can
--    never wipe the other token's Vault secret — and, crucially, once 2c blanks the
--    plaintext at rest, a NULL column value is a no-op here rather than a delete.
CREATE OR REPLACE FUNCTION public.user_credentials_vault_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  IF NEW.access_token IS NOT NULL THEN
    IF NEW.access_token_secret_id IS NULL THEN
      NEW.access_token_secret_id := vault.create_secret(NEW.access_token, NULL, 'user_credentials.access_token');
    ELSE
      PERFORM vault.update_secret(NEW.access_token_secret_id, NEW.access_token);
    END IF;
  END IF;

  IF NEW.refresh_token IS NOT NULL THEN
    IF NEW.refresh_token_secret_id IS NULL THEN
      NEW.refresh_token_secret_id := vault.create_secret(NEW.refresh_token, NULL, 'user_credentials.refresh_token');
    ELSE
      PERFORM vault.update_secret(NEW.refresh_token_secret_id, NEW.refresh_token);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_credentials_vault_sync ON public.user_credentials;
CREATE TRIGGER trg_user_credentials_vault_sync
  BEFORE INSERT OR UPDATE ON public.user_credentials
  FOR EACH ROW EXECUTE FUNCTION public.user_credentials_vault_sync();

-- 3. Backfill: mirror the existing rows' plaintext into Vault. A no-op self-update
--    fires the BEFORE trigger, which populates the new *_secret_id columns. Reads
--    only existing data; writes only the just-added columns.
UPDATE public.user_credentials
   SET access_token = access_token
 WHERE access_token_secret_id IS NULL
    OR (refresh_token IS NOT NULL AND refresh_token_secret_id IS NULL);
