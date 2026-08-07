-- Stage 4 (security-hardening): dedicated non-service_role DB role for the developer (Ayman).
--
-- Grants FULL read/write/DDL on the application data in `public`, across ALL orgs
-- (BYPASSRLS so RLS does not hide tenant rows during debugging), BUT is WALLED OFF
-- from decryption:
--   * NO EXECUTE on any SECURITY DEFINER function in public. Those run as their owner
--     (postgres) regardless of caller, so EXECUTE on them = the power to decrypt / read
--     the vault. The five crypto fns (decrypt_token, encrypt_token, vault_read_secret,
--     vault_create_secret, vault_update_secret) are the core of that set; revoking ALL
--     SECDEF fns also closes indirect escalation.
--   * NO USAGE on the vault / pgsodium schemas (left at default -> nothing granted), so
--     the role cannot even reference the encrypted stores.
-- Result: the role sees ciphertext only and cannot decrypt any secret or user token.
--
-- Password is NOT stored in this file; it is set out-of-band via ALTER ROLE and kept in
-- Vault. Reversible kill switch: `ALTER ROLE developer NOLOGIN;` (+ terminate backends)
-- or `DROP ROLE developer;`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'developer') THEN
    CREATE ROLE developer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
  END IF;
END $$;

-- Full access to the application data in public.
GRANT USAGE, CREATE ON SCHEMA public TO developer;
GRANT ALL ON ALL TABLES    IN SCHEMA public TO developer;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO developer;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO developer;

-- Future tables/sequences created by postgres (migrations) are auto-granted.
-- Functions are intentionally NOT auto-granted, so a future crypto/SECDEF function is
-- walled off by default until explicitly reviewed and granted.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES    TO developer;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO developer;

-- THE DECRYPTION WALL: revoke EXECUTE on every SECURITY DEFINER function in public.
-- Trigger firing is unaffected (triggers do not check EXECUTE privilege), so
-- encrypt-on-write keeps working for user_credentials / smrtbot_bots.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND p.prokind = 'f'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM developer', r.sig);
  END LOOP;
END $$;
