-- ============================================================
-- smrtCRM/smrtReach — backend gap-fills
-- ============================================================
-- 1. smrtcrm_api_connections.token — a secret used by the public inbound API
--    ingest endpoint (CRM-1: contacts entering through a connection are
--    auto-tagged). The token identifies the connection (and thus org + tag).
-- 2. smrtreach_queue.claimed_at — set when a row is claimed for sending, so a
--    reaper can reset rows orphaned in 'sending' after a crash/timeout.

ALTER TABLE smrtcrm_api_connections ADD COLUMN IF NOT EXISTS token text;
CREATE UNIQUE INDEX IF NOT EXISTS smrtcrm_api_connections_token_uidx
  ON smrtcrm_api_connections(token) WHERE token IS NOT NULL;

ALTER TABLE smrtreach_queue ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
