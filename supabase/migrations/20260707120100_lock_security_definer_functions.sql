-- Lock down SECURITY DEFINER functions exposed via PostgREST /rpc that are
-- only ever invoked by trusted contexts (security advisor findings):
--   push_on_notification            — trigger function (fires via table trigger)
--   smrtreach_gmail_quota_inc       — called by the Express server (service role)
--   suggest_skip_rules_from_history — called by the pg_cron job (postgres role)
--   accept_my_invites               — called by signed-in users at login; keep
--                                     authenticated, revoke anon only
REVOKE EXECUTE ON FUNCTION public.push_on_notification() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.smrtreach_gmail_quota_inc(uuid, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.suggest_skip_rules_from_history() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_my_invites() FROM anon;
