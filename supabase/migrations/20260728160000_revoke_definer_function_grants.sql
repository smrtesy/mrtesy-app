-- Close EXECUTE on the SECURITY DEFINER functions to anon/authenticated/PUBLIC.
--
-- WHY THE EARLIER REVOKE DID NOT WORK
-- Migration 20260728031000 wrote `REVOKE ALL ON FUNCTION seed_classifier_golden_set
-- FROM PUBLIC` and its comment stated the risk plainly: a SECURITY DEFINER
-- function with a default grant "would let ANY authenticated user trigger a write
-- across every tenant's rows". The REVOKE was literally executed and still left
-- exactly that state, because Supabase projects ship `ALTER DEFAULT PRIVILEGES`
-- that grant EXECUTE to `anon` and `authenticated` at CREATE time. Those are
-- ROLE grants, not the PUBLIC pseudo-role, so revoking PUBLIC removed a grant
-- that was never the exposure. Verified in pg_proc.proacl afterwards:
--   seed_classifier_golden_set → anon=X | authenticated=X | service_role=X
-- i.e. an unauthenticated POST to /rest/v1/rpc/seed_classifier_golden_set was
-- accepted. The lesson worth keeping: on this platform, assert the ACL after a
-- REVOKE — the statement succeeding says nothing about the outcome.
--
-- WHAT EACH ONE EXPOSED
--   seed_classifier_golden_set  SECURITY DEFINER, WRITES. Any caller could seed
--                               the golden set across every tenant's rows.
--   check_cross_party_merges    SECURITY DEFINER, writes log_entries and
--                               notifications. Held EXECUTE for PUBLIC as well
--                               as anon/authenticated, so any caller could
--                               manufacture error logs and push notifications.
--                               Its only legitimate caller is the pg_cron job,
--                               which runs as the table owner.
--   classifier_quality_metrics  SECURITY INVOKER, so RLS already scopes a
--                               caller to their own rows and this is not a data
--                               leak. `anon` still has no business holding
--                               EXECUTE on a platform-metrics function; the
--                               admin page reads it with the service role and
--                               `authenticated` keeps it by design.
--
-- Pure REVOKEs: nothing gains access, and the only callers that lose it are ones
-- that were never supposed to have it. Re-runnable.

-- Signature taken from pg_get_function_identity_arguments, not from the earlier
-- migration text: a REVOKE naming the wrong argument types errors out, and one
-- naming a DIFFERENT overload would silently leave the real function open.
REVOKE EXECUTE ON FUNCTION public.seed_classifier_golden_set(integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.seed_classifier_golden_set(integer, timestamptz)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.check_cross_party_merges()
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.check_cross_party_merges()
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.classifier_quality_metrics(integer, uuid)
  FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.classifier_quality_metrics(integer, uuid)
  TO authenticated, service_role;
