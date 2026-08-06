-- Security-hardening plan §5.1, step 2c (DATA-CHANGING / DESTRUCTIVE).
--
-- Step 2a added the Vault mirror trigger + backfilled the *_secret_id columns;
-- step 2b cut every reader (server + 9 edge functions) over to Vault-first with
-- a plaintext fallback; the two frontend screens that read the token in the
-- browser were rewritten to server endpoints. The plaintext access_token /
-- refresh_token columns are now DEAD DATA — kept only as the fallback, and
-- verified (2026-08-06) to match their Vault secret byte-for-byte on all rows.
--
-- This step removes the plaintext at rest. It does TWO things so the removal is
-- PERMANENT rather than re-dirtied on the next write (token-refresh rewrites
-- access_token roughly hourly; the OAuth callback rewrites both on reconnect):
--
--   1. Upgrade the mirror trigger to BLANK the plaintext after mirroring it to
--      Vault. From now on every write persists the token in Vault and stores
--      NULL in the column — true encryption-at-write. (The mirror still runs
--      first, so nothing is lost; the NULL-safety the 2a trigger already had —
--      "a NULL column is a no-op, not a delete" — keeps a token-refresh that
--      omits refresh_token from wiping the Vault refresh secret.)
--   2. Blank the existing rows: a no-op self-touch fires the upgraded trigger,
--      which re-mirrors (idempotent) and nulls both columns.
--
-- Reversibility: the DATA is not recoverable from this table afterward, but the
-- real tokens live in Vault (verified), so the app is unaffected. To roll the
-- BEHAVIOUR back, restore the 2a trigger body (without the two blanking lines).

-- 0. access_token carried a NOT NULL constraint (refresh_token was already
--    nullable). Blanking it to NULL — and the trigger blanking every future
--    write — needs the column nullable. DROP NOT NULL only RELAXES a constraint
--    (reversible, touches no data).
ALTER TABLE public.user_credentials
  ALTER COLUMN access_token DROP NOT NULL;

-- 1. Upgrade the trigger: mirror to Vault, THEN blank the plaintext at rest.
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

  -- Encryption-at-write: the plaintext has been mirrored into Vault above; never
  -- persist it in the row. A NULL here is what every reader now expects (2b),
  -- and a NULL on a later write is a no-op in the blocks above (never a wipe).
  NEW.access_token := NULL;
  NEW.refresh_token := NULL;

  RETURN NEW;
END;
$$;

-- 2. Blank the existing rows. The self-touch fires the upgraded trigger, which
--    re-mirrors (idempotent update_secret) and nulls both columns.
UPDATE public.user_credentials
   SET access_token = access_token
 WHERE access_token IS NOT NULL
    OR refresh_token IS NOT NULL;
