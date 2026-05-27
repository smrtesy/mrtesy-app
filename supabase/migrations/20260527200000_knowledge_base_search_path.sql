-- Pin search_path on match_knowledge_base to silence the Supabase
-- database-linter finding 0011 (function_search_path_mutable).
--
-- A SECURITY INVOKER sql function with a mutable search_path can be made to
-- resolve `knowledge_base` / the `<=>` vector operator against an
-- attacker-controlled schema. Pinning to `public` (where the table, the
-- vector extension, and the operator all live) makes resolution deterministic.
--
-- Idempotent and non-destructive: only sets a function attribute.

ALTER FUNCTION public.match_knowledge_base(vector, uuid, double precision, integer)
  SET search_path = public;
