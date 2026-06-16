-- ============================================================
-- smrtReach — WhatsApp per-recipient timezone send hour
-- ============================================================
-- When set, the broadcast is scheduled so each recipient receives it at this
-- LOCAL hour (0-23) in their own timezone (derived from phone prefix), instead
-- of all at once (botsite campaignBroadcast timezone groups). Null = off.

ALTER TABLE smrtreach_campaign_whatsapp
  ADD COLUMN IF NOT EXISTS tz_hour int;
