-- ============================================================
-- smrtVault — Credential vault schema
-- ============================================================
-- A personal password vault. Each row is ONE login the user stored
-- (a website/service). The password itself is NEVER kept on the row —
-- it lives in Supabase Vault (encrypted at rest) and the row keeps only
-- the Vault secret id (`password_secret_id`). Non-secret metadata
-- (label, username, url, notes) is kept in the clear so the vault list
-- and task<->login matching can work without decrypting anything.
--
-- SECURITY: RLS is ENABLED with NO policy on purpose. This table points
-- at secret material, so it must be unreachable by the authenticated
-- browser client. All reads/writes go through the service-role Express
-- server (which bypasses RLS); every query is scoped by BOTH org_id and
-- user_id, so a credential is private to the user who created it even
-- within a shared org. The password plaintext leaves the server only via
-- the explicit /vault/credentials/:id/reveal route (used by the browser
-- extension to autofill), and every reveal is written to
-- smrtvault_access_log below.
--
-- Deletion note: Supabase Vault exposes no delete RPC in this project, so
-- on credential delete the server first overwrites the secret with an
-- empty string (vault_update_secret) — leaving no readable plaintext —
-- and then deletes the row. The (now-empty) Vault secret is orphaned by
-- design; there is nothing sensitive left in it.

-- ─── updated_at trigger ──────────────────────────────────────
CREATE OR REPLACE FUNCTION smrtvault_set_updated_at() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ─── 1. Credentials (metadata + Vault pointer) ───────────────
CREATE TABLE IF NOT EXISTS smrtvault_credentials (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  label               text NOT NULL,
  username            text,
  url                 text,
  password_secret_id  uuid NOT NULL,   -- Vault secret id for the password
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvault_credentials ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only (see SECURITY note above).

CREATE INDEX IF NOT EXISTS smrtvault_credentials_owner_idx
  ON smrtvault_credentials(org_id, user_id);

CREATE TRIGGER smrtvault_credentials_updated_at BEFORE UPDATE ON smrtvault_credentials
  FOR EACH ROW EXECUTE FUNCTION smrtvault_set_updated_at();

-- ─── 2. Access log (audit trail for reveals) ─────────────────
-- One row per sensitive access to a credential. `action` is 'reveal'
-- today (the extension pulling the plaintext to autofill); kept as a
-- free-form CHECK so future actions ('export', etc.) can be added
-- without a schema change to the enum.
CREATE TABLE IF NOT EXISTS smrtvault_access_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id)   ON DELETE CASCADE,
  credential_id  uuid REFERENCES smrtvault_credentials(id) ON DELETE SET NULL,
  action         text NOT NULL DEFAULT 'reveal'
                   CHECK (action IN ('reveal', 'export')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE smrtvault_access_log ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only (audit rows, server-written).

CREATE INDEX IF NOT EXISTS smrtvault_access_log_owner_idx
  ON smrtvault_access_log(org_id, user_id, created_at DESC);
