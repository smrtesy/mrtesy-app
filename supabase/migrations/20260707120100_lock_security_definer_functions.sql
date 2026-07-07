-- Lock down SECURITY DEFINER functions exposed via PostgREST /rpc that are
-- only ever invoked by trusted contexts (security advisor findings).
-- NOTE: functions get EXECUTE for PUBLIC by default, and anon/authenticated
-- inherit it — revoking only their explicit grants is a no-op. Revoke PUBLIC
-- and re-grant the roles that legitimately call each function.

-- trigger function (fires via table trigger; EXECUTE is checked at trigger
-- creation, not at fire time)
REVOKE EXECUTE ON FUNCTION public.push_on_notification() FROM PUBLIC, anon, authenticated;

-- called by the Express server (service role)
REVOKE EXECUTE ON FUNCTION public.smrtreach_gmail_quota_inc(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smrtreach_gmail_quota_inc(uuid, text) TO service_role;

-- called by the pg_cron job (postgres role)
REVOKE EXECUTE ON FUNCTION public.suggest_skip_rules_from_history() FROM PUBLIC, anon, authenticated;

-- called by signed-in users at login; keep authenticated
REVOKE EXECUTE ON FUNCTION public.accept_my_invites() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_my_invites() TO authenticated;
