-- Security-hardening plan §5.1, step 3c (DATA-CHANGING / DESTRUCTIVE).
--
-- Step 3a added the Vault mirror trigger + backfilled the *_secret_id columns;
-- step 3b cut resolveCreds() over to Vault-first (plaintext only a fallback) and
-- made the token fields write-only in the UI. The deploy is live and verified
-- (2026-08-06: GET /bot/bots redacts the plaintext, and the daily health-check
-- cron reports the live bots healthy against Meta through the Vault read). The
-- plaintext live_wa_access_token / test_wa_access_token columns are now DEAD DATA.
--
-- This step removes the plaintext at rest, PERMANENTLY (a later write must not
-- re-dirty it — the health-check probe and the OAuth-less bot editor can rewrite
-- a token on replace). Two things, mirroring 2c:
--
--   1. Upgrade the mirror trigger to BLANK the plaintext after mirroring it to
--      Vault. Every future write persists the token in Vault and stores NULL in
--      the column — true encryption-at-write. The mirror still runs first
--      (nothing lost), the empty-string + NULL guards still hold (a blank or
--      absent field never wipes the Vault secret).
--   2. Blank the existing rows: a no-op self-touch fires the upgraded trigger,
--      which re-mirrors (idempotent) and nulls both columns.
--
-- No DROP NOT NULL is needed: live_wa_access_token / test_wa_access_token are
-- already nullable (verified — no NOT NULL constraint on either).
--
-- Reversibility: the DATA is not recoverable from this table afterward, but the
-- real tokens live in Vault (verified byte-for-byte), so the app is unaffected.
-- To roll the BEHAVIOUR back, restore the 3a trigger body (without the two
-- blanking lines); to restore a plaintext value, read it from its Vault secret.

-- 1. Upgrade the trigger: mirror to Vault, THEN blank the plaintext at rest.
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

  -- Encryption-at-write: the plaintext has been mirrored into Vault above; never
  -- persist it in the row. A NULL here is what every reader now expects (3b), and
  -- a NULL/'' on a later write is a no-op in the blocks above (never a wipe).
  NEW.live_wa_access_token := NULL;
  NEW.test_wa_access_token := NULL;

  RETURN NEW;
END;
$$;

-- 2. Blank the existing rows. The self-touch fires the upgraded trigger, which
--    re-mirrors (idempotent update_secret) and nulls both columns.
UPDATE public.smrtbot_bots
   SET live_wa_access_token = live_wa_access_token
 WHERE live_wa_access_token IS NOT NULL
    OR test_wa_access_token IS NOT NULL;
