-- Security-hardening plan §5.1, step 3a (ADDITIVE / reversible).
--
-- Step 3 mirrors step 2 (user_credentials) onto smrtbot_bots: the Meta WhatsApp
-- access tokens live_wa_access_token / test_wa_access_token are stored as
-- PLAINTEXT (verified 2026-08-06: all three bots carry ~200-char "EAA…" Graph
-- tokens in the clear). Once the developer role of the security plan is granted
-- direct DB access, those plaintext tokens would be readable in a dump — "send
-- WhatsApp as the business". Move them into Supabase Vault, exactly as 2a did.
--
-- This is the REVERSIBLE foundation only. It does NOT remove or blank any
-- plaintext — both the plaintext columns and the new Vault refs are kept in sync
-- (dual storage), so every existing reader keeps working untouched. Blanking the
-- plaintext at rest is the SEPARATE, data-changing step 3c that needs explicit
-- owner approval + a SELECT preview.
--
-- We copy 2a's proven shape verbatim (SECURITY DEFINER trigger calling
-- vault.create_secret / vault.update_secret DIRECTLY, mirroring only non-NULL
-- plaintext). The direct vault.* calls (not the public wrappers, which hard-require
-- service_role) keep the trigger correct regardless of the writer's role.
--
-- The legacy single-env column wa_access_token is NULL on every bot and has no
-- Vault ref column — it stays a plaintext-only fallback (resolveCreds still reads
-- it last). app_secret (write-only, born on Vault via live/test_app_secret_id) is
-- a separate concern and untouched here.

-- 1. Vault-ref columns (nullable — a row is valid before its first write mirrors it).
ALTER TABLE public.smrtbot_bots
  ADD COLUMN IF NOT EXISTS live_wa_access_token_secret_id uuid,
  ADD COLUMN IF NOT EXISTS test_wa_access_token_secret_id uuid;

COMMENT ON COLUMN public.smrtbot_bots.live_wa_access_token_secret_id IS
  'Supabase Vault secret id holding live_wa_access_token (security plan §5.1 / 3a). '
  'The plaintext column is kept in sync until step 3c blanks it.';
COMMENT ON COLUMN public.smrtbot_bots.test_wa_access_token_secret_id IS
  'Supabase Vault secret id holding test_wa_access_token (security plan §5.1 / 3a).';

-- 2. Mirror-to-Vault trigger. Only ever mirrors a plaintext that is neither NULL
--    NOR the empty string, so a writer that touches only one env's token (or
--    PATCHes an empty field) can never wipe the other's — or its own — Vault
--    secret. ("" IS NOT NULL is TRUE, so an empty-string guard is required in
--    addition to the NULL check; without it a blank PATCH would overwrite the
--    live token in Vault with ''.) Once 3c blanks the plaintext at rest, a NULL
--    column value is likewise a no-op here rather than a delete.
CREATE OR REPLACE FUNCTION public.smrtbot_bots_wa_vault_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
BEGIN
  IF NEW.live_wa_access_token IS NOT NULL AND NEW.live_wa_access_token <> '' THEN
    IF NEW.live_wa_access_token_secret_id IS NULL THEN
      NEW.live_wa_access_token_secret_id := vault.create_secret(NEW.live_wa_access_token, NULL, 'smrtbot_bots.live_wa_access_token');
    ELSE
      PERFORM vault.update_secret(NEW.live_wa_access_token_secret_id, NEW.live_wa_access_token);
    END IF;
  END IF;

  IF NEW.test_wa_access_token IS NOT NULL AND NEW.test_wa_access_token <> '' THEN
    IF NEW.test_wa_access_token_secret_id IS NULL THEN
      NEW.test_wa_access_token_secret_id := vault.create_secret(NEW.test_wa_access_token, NULL, 'smrtbot_bots.test_wa_access_token');
    ELSE
      PERFORM vault.update_secret(NEW.test_wa_access_token_secret_id, NEW.test_wa_access_token);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_smrtbot_bots_wa_vault_sync ON public.smrtbot_bots;
CREATE TRIGGER trg_smrtbot_bots_wa_vault_sync
  BEFORE INSERT OR UPDATE ON public.smrtbot_bots
  FOR EACH ROW EXECUTE FUNCTION public.smrtbot_bots_wa_vault_sync();

-- 3. Backfill: mirror the existing rows' plaintext into Vault. A no-op self-update
--    fires the BEFORE trigger, which populates the new *_secret_id columns. Reads
--    only existing data; writes only the just-added columns.
UPDATE public.smrtbot_bots
   SET live_wa_access_token = live_wa_access_token
 WHERE (live_wa_access_token IS NOT NULL AND live_wa_access_token_secret_id IS NULL)
    OR (test_wa_access_token IS NOT NULL AND test_wa_access_token_secret_id IS NULL);
