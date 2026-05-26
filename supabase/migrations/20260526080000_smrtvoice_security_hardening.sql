-- ============================================================
-- smrtVoice — Security Hardening
-- ============================================================
-- Lint findings from Supabase advisors:
-- 1. function_search_path_mutable — pin search_path on all functions
-- 2. anon/authenticated can execute SECURITY DEFINER — revoke REST exposure;
--    only service_role (backend) should call these.
--
-- This migration is idempotent and safe to re-run.

ALTER FUNCTION public.smrtvoice_update_updated_at()
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.increment_project_progress(uuid, numeric, numeric)
  SET search_path = public, pg_catalog;

ALTER FUNCTION public.smrtvoice_seed_default_dictionaries(uuid, uuid)
  SET search_path = public, pg_catalog;

REVOKE EXECUTE ON FUNCTION public.increment_project_progress(uuid, numeric, numeric)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.smrtvoice_seed_default_dictionaries(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.increment_project_progress(uuid, numeric, numeric)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.smrtvoice_seed_default_dictionaries(uuid, uuid)
  TO service_role;
