-- Security: stop exposing our own SECURITY DEFINER / trigger functions over the
-- REST API to anon + authenticated (Supabase advisor WARN).
--
-- All public-schema functions are granted EXECUTE to anon, authenticated,
-- service_role by Supabase default. None of the functions below should be
-- callable by a browser client:
--   * check_claude_usage_limits / recalibrate_claude_usage_caps /
--     record_claude_usage_hit — SECURITY DEFINER, invoked only server-side via
--     the service_role client (db.rpc). service_role keeps EXECUTE, so revoking
--     anon/authenticated does not break the server.
--   * user_credentials_vault_sync / smrtbot_bots_wa_vault_sync /
--     assign_claude_thread_serial / smrtdesign_update_updated_at — trigger
--     functions. Triggers fire regardless of EXECUTE grants, so revoking is a
--     pure surface reduction.
--
-- Also fixes function_search_path_mutable (advisor WARN) on the two trigger
-- functions that lack a pinned search_path. assign_claude_thread_serial calls
-- nextval('claude_thread_seq') (an unqualified public relation), so search_path
-- must include public.
--
-- All statements are reversible (GRANT restores; ALTER … RESET restores) and
-- touch no table data.
--
-- Revoke from PUBLIC, not just anon/authenticated: Supabase grants EXECUTE to
-- BOTH the explicit anon/authenticated roles AND to PUBLIC (the leading `=X` ACL
-- entry). anon/authenticated are members of PUBLIC, so revoking the explicit
-- grants alone leaves them able to execute via PUBLIC — the advisor keeps
-- flagging them. Revoking PUBLIC removes that path; the function owner (postgres)
-- and service_role keep their own explicit grants, so cron + server RPC still work.
--
-- NOT touched here (reported separately): pgaudit_ddl_command_end /
-- pgaudit_sql_drop (extension functions owned by supabase_admin, not ours) and
-- the auth_rls_initplan performance findings (RLS policy refactor).

REVOKE EXECUTE ON FUNCTION public.check_claude_usage_limits(boolean)  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.recalibrate_claude_usage_caps()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_claude_usage_hit(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.user_credentials_vault_sync()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.smrtbot_bots_wa_vault_sync()        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_claude_thread_serial()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.smrtdesign_update_updated_at()      FROM PUBLIC, anon, authenticated;

ALTER FUNCTION public.assign_claude_thread_serial()  SET search_path = public;
ALTER FUNCTION public.smrtdesign_update_updated_at() SET search_path = public;
