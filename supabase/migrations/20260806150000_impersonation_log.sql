-- Security-hardening plan §7 step 8 — mandatory audit of every impersonation.
--
-- Any time a session is minted AS another user we now write one row here, from
-- BOTH mint paths:
--   * owner/admin org preview  → POST /api/org/members/:userId/preview-link
--     (via='owner_admin'), and
--   * super-admin cross-org     → POST /api/admin/impersonate/:userId
--     (via='super_admin').
--
-- This is append-only forensic evidence: who impersonated whom, in which org,
-- from which IP, and the exact token issued (so a token in member_preview_tokens
-- can be traced back to the actor). It is the most urgent piece of step 8 — the
-- preview feature mints a REAL session as the target, and until now that left no
-- trace at all.
--
-- Backend-only, like org_secrets / member_preview_tokens: written and read solely
-- by the service-role backend, invisible to the anon/authenticated frontend.
CREATE TABLE IF NOT EXISTS public.impersonation_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid NOT NULL,
  target_user_id uuid NOT NULL,
  org_id         uuid NOT NULL,
  via            text NOT NULL CHECK (via IN ('owner_admin', 'super_admin')),
  ip             text,
  token          uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Look up "who did the actor impersonate" and "who impersonated this target".
CREATE INDEX IF NOT EXISTS idx_impersonation_log_actor
  ON public.impersonation_log (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impersonation_log_target
  ON public.impersonation_log (target_user_id, created_at DESC);

COMMENT ON TABLE public.impersonation_log IS
  'Security plan §7 step 8: append-only audit of every minted impersonation '
  'session (owner/admin preview + super-admin cross-org). Backend-only '
  '(service-role); no frontend access.';

-- Deny all direct table access; the service-role backend bypasses RLS and is the
-- sole path in. Identical stance to org_secrets_no_one / app_secrets_no_one.
ALTER TABLE public.impersonation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_log_no_one ON public.impersonation_log;
CREATE POLICY impersonation_log_no_one ON public.impersonation_log
  FOR ALL TO public USING (false) WITH CHECK (false);
