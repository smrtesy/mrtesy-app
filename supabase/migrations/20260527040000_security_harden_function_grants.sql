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
--
-- These functions (and the trigger functions below) are defined directly in
-- the live database rather than in this migrations dir — same as the base
-- tables. We guard every statement with to_regprocedure(...) so the migration
-- is a no-op for any object that doesn't exist in the target DB instead of
-- aborting the whole transaction on a fresh environment.

DO $$
DECLARE
  fn text;
  secdef text[] := ARRAY[
    'public.decrypt_token(text)',
    'public.encrypt_token(text)',
    'public.rls_auto_enable()',
    'public.vault_create_secret(text, text, text)',
    'public.vault_read_secret(uuid)',
    'public.vault_update_secret(uuid, text)'
  ];
  triggers text[] := ARRAY[
    'public.set_updated_at()',
    'public.fill_org_id_from_user()',
    'public.bump_conversation_last_message_at()',
    'public.touch_smrttask_system_params_updated_at()',
    'public.assign_router_decision_serial()',
    'public.touch_router_decisions_updated_at()',
    'public.update_tasks_updated_at()',
    'public.assign_source_message_serial()',
    'public.assign_task_serial()',
    'public.update_app_secrets_updated_at()'
  ];
BEGIN
  -- 1) Restrict SECURITY DEFINER functions to service_role only.
  FOREACH fn IN ARRAY secdef LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
  END LOOP;

  -- 2) Pin search_path on trigger functions. Behavior-preserving: every
  --    reference resolves in public (tables, sequences); now() resolves via
  --    implicit pg_catalog; auth.uid() is already schema-qualified.
  FOREACH fn IN ARRAY triggers LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public', fn);
    END IF;
  END LOOP;
END $$;
