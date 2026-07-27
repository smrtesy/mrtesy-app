-- Migration: fold fal.ai spend into ai_usage_summary(), and report rows that
-- carry no cost at all.
--
-- APPLIED to the Smrtesy production project on 2026-07-27 with the user's explicit
-- go-ahead; the filename version matches the recorded migration row. The DROP +
-- CREATE is re-runnable, so a later `supabase db push` is a no-op.
--
-- WHY
-- /admin/usage called itself a ledger of every paid AI call, but fal.ai image and
-- video generation for smrtStudio never wrote to public.ai_usage — it is recorded
-- per run in public.experiment_runs by the video-lab harness ($3.72 over 61 runs
-- so far). A total that silently omits a whole provider is the same class of
-- defect as the truncation bug: the number looks complete and isn't.
--
-- WHY A UNION AND NOT MIRRORED ROWS
-- The obvious alternative is to write a provider='fal' row into ai_usage next to
-- each experiment_runs row. Rejected: the harness UPSERTS runs on (org_id, code)
-- and re-posts the same run whenever it re-syncs its local runs.jsonl (e.g. after
-- QC is recomputed), so mirrored inserts would duplicate on every re-sync, and
-- ai_usage has no natural key to upsert against. Reading experiment_runs directly
-- keeps one source of truth and makes the 61 existing runs and every future run
-- correct with no harness change.
--
-- BLIND SCORING IS PRESERVED
-- experiment_runs.model is hidden until a score is locked (video-lab rule 9:
-- visible code, hidden model). The operator and the scorer are currently the same
-- person, so surfacing model names on an admin cost page would leak the blind.
-- fal groups therefore report model as '—' on purpose and are grouped by stage.
-- Cost does not depend on knowing which model it was.
--
-- NEW COLUMN: missing_cost
-- 20 of the 61 fal runs have cost_usd IS NULL — a third of them. Summing those as
-- zero and showing a clean total would misrepresent the figure, so the count comes
-- back with the data and the page warns. ai_usage.cost_usd is NOT NULL DEFAULT 0,
-- so this is always 0 for the API-provider groups.
--
-- The return type gains a column, which CREATE OR REPLACE cannot do — hence the
-- explicit DROP. Callers select by name, so the added column breaks nothing.

DROP FUNCTION IF EXISTS public.ai_usage_summary(timestamptz, timestamptz, uuid, text);

CREATE FUNCTION public.ai_usage_summary(
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
  cache_write_tokens bigint,
  missing_cost       bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH api AS (
    SELECT
      u.provider,
      u.component,
      -- One component can span models (the classifier escalates Haiku→Sonnet), and
      -- the model is what makes a cost figure checkable against the price list.
      COALESCE(u.model, '—')                 AS model,
      count(*)                               AS calls,
      count(DISTINCT u.ref_id)               AS items,
      COALESCE(sum(u.cost_usd), 0)           AS cost_usd,
      COALESCE(sum(u.input_tokens), 0)       AS input_tokens,
      COALESCE(sum(u.output_tokens), 0)      AS output_tokens,
      COALESCE(sum(u.cache_read_tokens), 0)  AS cache_read_tokens,
      COALESCE(sum(u.cache_write_tokens), 0) AS cache_write_tokens,
      count(*) FILTER (WHERE u.cost_usd IS NULL) AS missing_cost
    FROM public.ai_usage u
    WHERE u.created_at >= p_since
      AND (p_until IS NULL OR u.created_at < p_until)
      AND (p_user_id IS NULL OR u.user_id = p_user_id)
      -- starts_with(), not LIKE: it matches the prefix literally, so a '%' or '_'
      -- in a caller-supplied prefix can never act as a wildcard and there is no
      -- escaping to get wrong.
      AND (p_component_prefix IS NULL OR starts_with(u.component, p_component_prefix))
    GROUP BY u.provider, u.component, COALESCE(u.model, '—')
  ),
  fal AS (
    SELECT
      'fal'::text                                  AS provider,
      'fal.' || COALESCE(r.stage, 'other')         AS component,
      '—'::text                                    AS model,  -- blind: see header
      count(*)                                     AS calls,
      count(DISTINCT r.code)                       AS items,
      COALESCE(sum(r.cost_usd), 0)                 AS cost_usd,
      0::bigint                                    AS input_tokens,
      0::bigint                                    AS output_tokens,
      0::bigint                                    AS cache_read_tokens,
      0::bigint                                    AS cache_write_tokens,
      count(*) FILTER (WHERE r.cost_usd IS NULL)   AS missing_cost
    FROM public.experiment_runs r
    WHERE r.created_at >= p_since
      AND (p_until IS NULL OR r.created_at < p_until)
      AND (p_user_id IS NULL OR r.created_by = p_user_id)
      -- Honour the component filter against the synthetic name, so a caller
      -- narrowing to e.g. 'server.' does not accidentally pull fal rows in.
      AND (p_component_prefix IS NULL
           OR starts_with('fal.' || COALESCE(r.stage, 'other'), p_component_prefix))
    GROUP BY COALESCE(r.stage, 'other')
  )
  SELECT * FROM api
  UNION ALL
  SELECT * FROM fal
  ORDER BY cost_usd DESC NULLS LAST;
$$;

COMMENT ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text) IS
  'All paid AI spend for a time window, grouped: token providers from ai_usage '
  'plus fal.ai generation read from experiment_runs. Aggregates server-side so '
  'the admin dashboard can never silently sum a PostgREST-truncated 1000-row '
  'sample. p_until is exclusive; NULL means "up to now". p_user_id / '
  'p_component_prefix are optional filters. missing_cost counts rows with no '
  'cost recorded, so a partial total is never presented as a complete one. fal '
  'model names are withheld ("—") to preserve blind scoring.';

REVOKE ALL ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ai_usage_summary(timestamptz, timestamptz, uuid, text)
  TO authenticated, service_role;
