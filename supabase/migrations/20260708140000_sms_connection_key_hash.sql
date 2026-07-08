-- ============================================================
-- SMS connection — signing-key hash for O(1) deviceId auto-heal
-- ============================================================
-- The inbound SMS webhook auto-heals a reinstalled device (new deviceId, same
-- registered secret) by matching the URL token against active connections.
-- Matching by reading every connection's Vault secret would let an
-- unauthenticated caller amplify one request into N Vault reads. Instead we
-- store the SHA-256 of the signing key and match it with a single indexed
-- lookup; the plaintext key still lives only in Vault. The hash is not a
-- usable credential on its own.
ALTER TABLE sms_connections
  ADD COLUMN IF NOT EXISTS signing_key_sha256 text;

-- Partial index: auto-heal only ever looks up active connections.
CREATE INDEX IF NOT EXISTS sms_connections_signing_key_sha256_idx
  ON sms_connections (signing_key_sha256)
  WHERE disconnected_at IS NULL;

-- Backfill active connections from their Vault secret so existing devices can
-- auto-heal without a reconnect. pgcrypto's digest lives in the extensions
-- schema on Supabase.
UPDATE sms_connections c
SET signing_key_sha256 = encode(extensions.digest(v.decrypted_secret, 'sha256'), 'hex')
FROM vault.decrypted_secrets v
WHERE v.id = c.signing_key_id
  AND c.disconnected_at IS NULL
  AND c.signing_key_sha256 IS NULL;
