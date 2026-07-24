-- Advisor hardening (health-check follow-ups, 2026-07-24)
--
-- Two WARN/ERROR advisor findings, both behavior-preserving:
--
--  (ב) v_stuck_source_messages was created SECURITY DEFINER (the default for
--      views), which the linter flags ERROR (security_definer_view): the view
--      would run with the owner's rights instead of the querying role's. It is
--      a monitoring-only view (referenced nowhere in app code), so switching it
--      to security_invoker is safe and closes the finding.
--
--  (ג) smrtvoice_seed_default_dictionaries(uuid, uuid) had a mutable search_path
--      (function_search_path_mutable WARN). Pin it to public — where every
--      object it touches lives — so it can't be hijacked via a caller-controlled
--      search_path.
--
-- Already applied to the Smrtesy prod project on 2026-07-24; committed here so
-- other environments converge.

ALTER VIEW public.v_stuck_source_messages SET (security_invoker = true);

ALTER FUNCTION public.smrtvoice_seed_default_dictionaries(uuid, uuid)
  SET search_path = public;
