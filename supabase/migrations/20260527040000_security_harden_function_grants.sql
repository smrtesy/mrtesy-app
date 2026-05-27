-- Security hardening: lock down SECURITY DEFINER functions and pin search_path.
--
-- Addresses Supabase database-linter findings:
--   0028 anon_security_definer_function_executable
--   0029 authenticated_security_definer_function_executable
--   0011 function_search_path_mutable
--
-- The vault_*/encrypt_token/decrypt_token functions are SECURITY DEFINER and
-- were callable by anon/authenticated via PostgREST RPC. Every caller in the
-- codebase uses the service-role client, so we revoke EXECUTE from
-- anon/authenticated/PUBLIC and keep it for service_role only.

REVOKE EXECUTE ON FUNCTION public.decrypt_token(text)                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.encrypt_token(text)                   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()                     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_create_secret(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_read_secret(uuid)               FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_update_secret(uuid, text)       FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.decrypt_token(text)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.encrypt_token(text)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_create_secret(text, text, text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_read_secret(uuid)                TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_update_secret(uuid, text)        TO service_role;

-- Pin search_path on trigger functions. Behavior-preserving: every reference
-- resolves in public (tables, sequences); now() resolves via implicit
-- pg_catalog; auth.uid() is already schema-qualified.
ALTER FUNCTION public.set_updated_at()                          SET search_path = public;
ALTER FUNCTION public.fill_org_id_from_user()                   SET search_path = public;
ALTER FUNCTION public.bump_conversation_last_message_at()       SET search_path = public;
ALTER FUNCTION public.touch_smrttask_system_params_updated_at() SET search_path = public;
ALTER FUNCTION public.assign_router_decision_serial()           SET search_path = public;
ALTER FUNCTION public.touch_router_decisions_updated_at()       SET search_path = public;
ALTER FUNCTION public.update_tasks_updated_at()                 SET search_path = public;
ALTER FUNCTION public.assign_source_message_serial()            SET search_path = public;
ALTER FUNCTION public.assign_task_serial()                      SET search_path = public;
ALTER FUNCTION public.update_app_secrets_updated_at()           SET search_path = public;
