-- Retention for high-write debug/log tables (incident 2026-07-30 follow-up).
-- These tables grew unbounded and their write churn feeds WAL/IO. Each retention
-- window was chosen against a read audit (see docs/supabase-io-incident-2026-07-30.md):
--   * whatsapp_webhook_debug — write-only, NO reader anywhere → keep 7 days
--   * smrtbot_webhook_debug  — read by the bot "Webhook log" UI tab → keep 30 days
--   * log_entries            — read by admin Logs + the daily health report;
--                              error/fatal/critical rows are kept FOREVER, the
--                              rest kept 30 days.
-- Reversible: DROP the cron job (cron.unschedule('cleanup-debug-logs')) and the
-- function to revert. No schema/behavioral change to any feature.

CREATE OR REPLACE FUNCTION public.cleanup_debug_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.whatsapp_webhook_debug
   WHERE received_at < now() - interval '7 days';

  DELETE FROM public.smrtbot_webhook_debug
   WHERE created_at < now() - interval '30 days';

  DELETE FROM public.log_entries
   WHERE COALESCE(level, '') NOT IN ('error', 'fatal', 'critical')
     AND created_at < now() - interval '30 days';
END $$;

-- Nightly at 08:30 UTC (04:30 America/New_York) — a quiet hour.
SELECT cron.unschedule('cleanup-debug-logs')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-debug-logs');
SELECT cron.schedule('cleanup-debug-logs', '30 8 * * *', 'SELECT public.cleanup_debug_logs();');
