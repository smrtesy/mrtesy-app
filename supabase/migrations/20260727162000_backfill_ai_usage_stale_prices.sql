-- Migration: re-price historical ai_usage rows that were logged at stale rates.
--
-- WHY
-- Several call sites carried their own copy of the price table and were never
-- updated when the rates changed (fixed in code alongside this migration):
--   * drive-sync `drive_ocr`            — Haiku 3.5's $0.80/$4
--   * project-detection                 — Haiku $0.8/$4, Opus $15/$75 (Opus 4.1)
--   * quick-action                      — every model priced as Sonnet $3/$15
--   * ai-process + server, pre-2026-07-26 — Haiku $0.80/$4
-- Result: 7,780 of 9,096 uncached Anthropic rows were priced wrong, and the
-- ledger understated real spend by ~$5.53 in total. Fixing the code stops new
-- rows from being wrong; this fixes the rows already written, so the historical
-- windows on /admin/usage also reflect what was actually billed.
--
-- SCOPE — deliberately limited to rows with NO cache tokens.
-- For a cached call the correct cost depends on the cache TTL the caller
-- requested (a write bills 1.25× input at 5m and 2× at 1h), and the ledger does
-- not record which TTL was sent. Those rows cannot be recomputed without
-- guessing, and a guess is exactly what put this table out of sync in the first
-- place. Uncached rows are unambiguous: cost is fully determined by
-- (model, input_tokens, output_tokens) at list prices.
--
-- IDEMPOTENT: the WHERE clause only touches rows that differ from the correct
-- figure, so re-running it is a no-op.
--
-- Rates (USD per 1M): Haiku 4.5 $1/$5 · Sonnet 4.6 $3/$15 · Opus 4.7–5 $5/$25.

BEGIN;

-- Snapshot the pre-correction totals so the change is auditable after the fact
-- rather than only visible in this file's comments.
DO $$
DECLARE
  v_rows   bigint;
  v_before numeric;
  v_after  numeric;
BEGIN
  SELECT count(*),
         COALESCE(sum(cost_usd), 0),
         COALESCE(sum(
           (input_tokens  * CASE WHEN model LIKE '%haiku%' THEN 1.0
                                 WHEN model LIKE '%sonnet%' THEN 3.0
                                 WHEN model LIKE '%opus%' THEN 5.0 END
          + output_tokens * CASE WHEN model LIKE '%haiku%' THEN 5.0
                                 WHEN model LIKE '%sonnet%' THEN 15.0
                                 WHEN model LIKE '%opus%' THEN 25.0 END) / 1000000.0
         ), 0)
    INTO v_rows, v_before, v_after
  FROM public.ai_usage
  WHERE provider = 'anthropic'
    AND cache_read_tokens = 0
    AND cache_write_tokens = 0
    AND model IS NOT NULL
    AND (model LIKE '%haiku%' OR model LIKE '%sonnet%' OR model LIKE '%opus%');

  RAISE NOTICE 'ai_usage re-price: % uncached anthropic rows, $% -> $% (delta $%)',
    v_rows, round(v_before, 4), round(v_after, 4), round(v_after - v_before, 4);
END $$;

UPDATE public.ai_usage AS u
SET cost_usd = c.correct_cost
FROM (
  SELECT
    id,
    ROUND(
      (input_tokens  * CASE WHEN model LIKE '%haiku%'  THEN 1.0
                            WHEN model LIKE '%sonnet%' THEN 3.0
                            WHEN model LIKE '%opus%'   THEN 5.0 END
     + output_tokens * CASE WHEN model LIKE '%haiku%'  THEN 5.0
                            WHEN model LIKE '%sonnet%' THEN 15.0
                            WHEN model LIKE '%opus%'   THEN 25.0 END
      ) / 1000000.0,
      6  -- match cost_usd's numeric(14,6) so the comparison below settles
    ) AS correct_cost
  FROM public.ai_usage
  WHERE provider = 'anthropic'
    AND cache_read_tokens = 0
    AND cache_write_tokens = 0
    AND model IS NOT NULL
    AND (model LIKE '%haiku%' OR model LIKE '%sonnet%' OR model LIKE '%opus%')
) AS c
WHERE u.id = c.id
  AND u.cost_usd IS DISTINCT FROM c.correct_cost;

COMMIT;
