-- ============================================================
-- smrtReach — Provider accounts + per-campaign sender allocation
-- ============================================================
-- Reorganizes email sending around a single MASTER LIST of send identities
-- (settings = the fixed config that does not change per campaign) and a
-- per-campaign ALLOCATION (which addresses to send from, and how many from
-- each). Three moving parts:
--
--   1. smrtreach_senders gains `provider` + `daily_cap` so the one table is
--      the master list for BOTH SES addresses and (independent) Gmail inboxes,
--      each with its own fixed safe daily ceiling.
--   2. smrtreach_gmail_accounts stores INDEPENDENT Gmail inboxes the org adds
--      explicitly (their own OAuth grant), NOT tied to a member's personal
--      user_credentials. The refresh token lives in Vault (secret id only).
--   3. smrtreach_campaign_senders is the per-campaign allocation: for a
--      campaign, how many emails go out from each chosen sender.
--   4. smrtreach_queue rows are stamped with the sender they were allocated to,
--      so the processor sends from the assigned address instead of re-picking.

-- ─── 1. Master list: provider + fixed per-address daily cap ──
ALTER TABLE smrtreach_senders
  ADD COLUMN IF NOT EXISTS provider  text NOT NULL DEFAULT 'ses'
    CHECK (provider IN ('ses','gmail')),
  -- The fixed "safe" daily ceiling for this address (e.g. 2000/day for Gmail).
  -- NULL = no explicit cap (SES addresses, or "unlimited"). Per-campaign
  -- allocations are clamped to this.
  ADD COLUMN IF NOT EXISTS daily_cap int CHECK (daily_cap IS NULL OR daily_cap > 0);

-- ─── 2. Independent Gmail inboxes (org-owned send identities) ─
-- One row per Gmail inbox the org explicitly connected for sending. Paired
-- 1:1 with a smrtreach_senders row (provider='gmail'). The refresh token is
-- stored in Vault — only its secret id is kept here. access_token is the
-- short-lived working token (refreshed in place by the send service).
--
-- SECURITY: RLS is ENABLED with NO policy on purpose. This table holds OAuth
-- material, so it must be unreachable by the authenticated browser client.
-- All reads/writes go through the service-role server (the Express send
-- service + the OAuth callback's admin client), which bypasses RLS. The
-- frontend only ever sees sanitized fields via /reach routes.
CREATE TABLE IF NOT EXISTS smrtreach_gmail_accounts (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_id                uuid NOT NULL REFERENCES smrtreach_senders(id) ON DELETE CASCADE,
  created_by               uuid REFERENCES auth.users(id),
  email                    text NOT NULL,
  refresh_token_secret_id  uuid,                 -- Vault secret id for the refresh token
  access_token             text,
  expires_at               timestamptz,
  scopes                   text[] NOT NULL DEFAULT ARRAY['gmail.send'],
  disabled                 boolean NOT NULL DEFAULT false,  -- set when the grant dies (invalid_grant)
  last_error               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

ALTER TABLE smrtreach_gmail_accounts ENABLE ROW LEVEL SECURITY;
-- Intentionally no policy: service-role only (see SECURITY note above).

CREATE TRIGGER smrtreach_gmail_accounts_updated_at BEFORE UPDATE ON smrtreach_gmail_accounts
  FOR EACH ROW EXECUTE FUNCTION smrtreach_set_updated_at();

-- ─── 3. Per-campaign sender allocation ───────────────────────
-- For a campaign: which senders to send from, and how many from each.
-- send_count is the budget for THIS campaign from THIS sender (clamped at
-- enqueue time to the sender's daily_cap and the resolved audience size).
CREATE TABLE IF NOT EXISTS smrtreach_campaign_senders (
  campaign_id uuid NOT NULL REFERENCES smrtreach_campaigns(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  sender_id   uuid NOT NULL REFERENCES smrtreach_senders(id) ON DELETE CASCADE,
  send_count  int  NOT NULL CHECK (send_count > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, sender_id)
);

ALTER TABLE smrtreach_campaign_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "smrtreach_campaign_senders_org_members" ON smrtreach_campaign_senders
  USING      (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE INDEX IF NOT EXISTS smrtreach_campaign_senders_campaign_idx
  ON smrtreach_campaign_senders(campaign_id);

-- ─── 4. Queue: bind each row to its allocated sender ─────────
-- The processor sends from this exact address (SES or the specific Gmail
-- inbox) instead of re-picking, so the per-campaign allocation is honored.
-- ON DELETE SET NULL: a deleted sender leaves the row's from_address intact
-- for SES; Gmail rows with a null sender_id fail gracefully (logged).
ALTER TABLE smrtreach_queue
  ADD COLUMN IF NOT EXISTS sender_id    uuid REFERENCES smrtreach_senders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS from_address text;
