-- ============================================================
-- smrtReach — send-control parity with the legacy botsite blast
-- ============================================================
-- Wires the columns the send pipeline now honors (scheduling window, Shabbat
-- exclusion, rate limit, recipient cap, send-time-optimization, frequency /
-- cooldown), plus the few new columns those features need. Everything is
-- additive (ADD COLUMN IF NOT EXISTS) so it is safe to re-run.
--
-- Migrated parity reference (botsite):
--   * src/email/emailQueue.js  — send_hours/send_days window, STO, freq/cooldown
--   * src/modules/campaignBroadcast.js — country_filter, max_recipients, body_text
--
-- Send-window model (Israel time, Asia/Jerusalem, DST-aware in code):
--   send_hours = { "start": <0-23>, "end": <0-23> }  ('{}' = no restriction)
--   exclude_shabbat = true → skip Fri from `shabbat_start_hour` through Sat night.

-- ─── EMAIL detail: send-time-optimization toggle ─────────────
ALTER TABLE smrtreach_campaign_email
  ADD COLUMN IF NOT EXISTS sto_enabled boolean NOT NULL DEFAULT false;

-- ─── WHATSAPP detail: free-text body + send window parity ────
-- A campaign sends EITHER a Meta template OR free text (body_text); the
-- send-service prefers `template` when set, else falls back to body_text.
ALTER TABLE smrtreach_campaign_whatsapp
  ADD COLUMN IF NOT EXISTS body_text       text,
  ADD COLUMN IF NOT EXISTS send_hours      jsonb   NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exclude_shabbat boolean NOT NULL DEFAULT true;

-- ─── CAMPAIGN master: country filter + test-batch gate ───────
-- country_filter narrows the resolved audience by phone prefix
-- ('all'|'israel'|'us'|'canada'|'europe'); test_batch_size > 0 sends only the
-- first N then parks the campaign in 'paused' awaiting an explicit resume
-- (botsite "מנה ראשונה").
ALTER TABLE smrtreach_campaigns
  ADD COLUMN IF NOT EXISTS country_filter  text,
  ADD COLUMN IF NOT EXISTS test_batch_size int;

-- ─── QUEUE: keep per-row scheduled_at honored ────────────────
-- (column + index already exist from the schema migration; the processor now
--  filters scheduled_at <= now(). Nothing to add — documented here for context.)

-- The CHECK on smrtcrm_contacts.email_frequency is ('all','weekly','monthly','none')
-- (see 20260603120100). The send pipeline maps campaign email priority
-- ('low','normal','high') → accepted frequency tiers + cooldown days in code.
