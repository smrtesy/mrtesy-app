-- ============================================================
-- smrtReach — "Send now" override (ignore time restrictions)
-- ============================================================
-- A campaign sent via the explicit "שלח עכשיו" action must go out immediately,
-- ignoring send_hours, exclude_shabbat, the per-row schedule and the rate limit.
-- A scheduled send (ignore_send_window = false) keeps honoring all of those.
-- Default false so existing/scheduled campaigns are unchanged.

ALTER TABLE smrtreach_campaigns
  ADD COLUMN IF NOT EXISTS ignore_send_window boolean NOT NULL DEFAULT false;
