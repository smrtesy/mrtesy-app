-- Migration: ai_usage_summary() — aggregate the AI cost ledger IN THE DATABASE.
--
-- THE BUG THIS FIXES
-- /admin/usage read raw ai_usage rows and summed them in JavaScript. PostgREST
-- caps any response at `db-max-rows` (1000 on this project) and that cap is
-- applied AFTER the filters, silently — the request asked for .limit(100000)
-- and got 1000 rows back with no error and no indication of truncation.
--
-- Consequences, both of which the user reported:
--   1. "7 days and a month show the same amount" — both windows have >1000 rows,
--      so both returned the same first 1000 rows and summed to the same figure.
--   2. "it doesn't match what I'm actually billed" — the 30-day window held
--      9,072 calls / $62.19 but the page showed 1,000 calls / $7.78, an ~8×
--      under-report. The page was showing a sample, labelled as a total.
--
-- Aggregating here makes truncation impossible: the whole window is summed by
-- Postgres and only one small grouped result set crosses the wire. It is also
-- what keeps the page fast as the ledger grows (19k rows today).
--
-- SECURITY: deliberately SECURITY INVOKER (the default). ai_usage has RLS
-- limiting SELECT to rows in public.super_admins, and an invoker-rights
-- function inherits that — so an ordinary authenticated user calling this RPC
-- aggregates over zero rows rather than over the whole platform's spend. The
-- /admin pages call it with the service-role key, which bypasses RLS as before.

-- p_user_id / p_component_prefix exist so every cost read in the codebase can go
-- through this one function. The price-tracker's own AI meter had an identical
-- unbounded select + JS sum (latent only because that component has no rows
-- yet); routing it here means the cap bug cannot come back through a second door.
CREATE OR REPLACE FUNCTION public.ai_usage_summary(
  p_since timestamptz,
  p_until timestamptz DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_component_prefix text DEFAULT NULL
)
RETURNS TABLE (
  provider           text,
  component          text,
  model              text,
  calls              bigint,
  items              bigint,
  cost_usd           numeric,
  input_tokens       bigint,
  output_tokens      bigint,
  cache_read_tokens  bigint,
  cache_write_tokens bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    u.provider,
    u.component,
    -- One component can span models (the classifier escalates Haiku→Sonnet), and
    -- the model is what makes a cost figure checkable against the price list.
    COALESCE(u.model, '—')                        AS model,
    count(*)                                      AS calls,
    count(DISTINCT u.ref_id)                      AS items,
    COALESCE(sum(u.cost_usd), 0)                  AS cost_usd,
    COALESCE(sum(u.input_tokens), 0)              AS input_tokens,
    COALESCE(sum(u.output_tokens), 0)             AS output_tokens,
    COALESCE(sum(u.cache_read_tokens), 0)         AS cache_read_tokens,
    COALESCE(sum(u.cache_write_tokens), 0)        AS cache_write_tokens
  FROM public.ai_usage u
  WHERE u.created_at >= p_since
    AND (p_until IS NULL OR u.created_at < p_until)
    AND (p_user_id IS NULL OR u.user_id = p_user_id)
    -- starts_with(), not LIKE: it matches the prefix literally, so a '%' or '_'
    -- in a caller-supplied prefix can never act as a wildcard and there is no
    -- escaping to get wrong.
    AND (p_component_prefix IS NULL OR starts_with(u.component, p_component_prefix))
  GROUP BY u.provider, u.component, COALESCE(u.model, '—')
  ORDER BY sum(u.cost_usd) DESC NULLS LAST;
$$;

COMMENT ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text) IS
  'Grouped AI spend for a time window. Aggregates server-side so the admin '
  'dashboard can never silently sum a PostgREST-truncated 1000-row sample. '
  'p_until is exclusive; NULL means "up to now". p_user_id / p_component_prefix '
  'are optional filters (NULL = no filter).';

-- anon has no business reading platform-wide spend, even though RLS would
-- already return nothing — no grant at all is the clearer statement.
REVOKE ALL ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text)
  TO authenticated, service_role;
