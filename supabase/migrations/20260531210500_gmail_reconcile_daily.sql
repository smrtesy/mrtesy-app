-- Run gmail-reconcile daily instead of weekly.
--
-- gmail-reconcile is the safety net that catches messages the live gmail-sync
-- misses (e.g. after a historyId reset). At the previous weekly cadence
-- ("0 3 * * 0", Sundays) a message the live sync missed could stay invisible
-- for up to 7 days, then surface all at once in a single Sunday-morning sweep
-- (this is what produced the batch of 3-day-old tasks on 2026-05-31).
-- Daily ("0 3 * * *") caps that worst-case lag at ~24h.
--
-- The cron job was created manually (no prior migration defines it), so look
-- it up by name rather than a hard-coded jobid.
SELECT cron.alter_job(
  (SELECT jobid FROM cron.job WHERE jobname = 'gmail-reconcile'),
  schedule => '0 3 * * *'
);
