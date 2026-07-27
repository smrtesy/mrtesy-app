-- Migration: re-price cached ai_usage rows at the 1h cache TTL the code requests.
--
-- APPLIED to the Smrtesy production project on 2026-07-27 with the user's explicit
-- go-ahead; the filename version matches the recorded migration row.
--
-- The earlier backfill (20260727153816) deliberately skipped every row with cache
-- tokens, on the grounds that a cache write bills 1.25x input at a 5m TTL and 2x at
-- 1h, and the ledger does not record which TTL was sent.
--
-- That caution was misplaced. The TTL is not stored, but it IS determined by the
-- call site, and every call site that has ever written cache tokens asks for 1h.
-- Verified exhaustively against the components actually present in the data:
--   ai_process.classify / ai_process.task / shadow_eval
--       -> supabase/functions/ai-process/index.ts cachedSystem(), which hardcodes
--          cache_control: { type: "ephemeral", ttl: "1h" }
--   server.smrtinfo.extract
--       -> server/src/modules/smrtinfo/extract.ts passes { cacheSystem: true }, and
--          simpleCall() in server/src/anthropic.ts pins cacheTtl = "1h"
-- No component writes cache tokens at a 5m TTL, so 2x is not a guess here. If a
-- future call site DOES cache at 5m, this migration must not simply be re-run
-- against it — add a ttl column to the ledger first.
--
-- 2,952 of 8,032 cached rows were written before the 2026-07-26 TTL fix and carried
-- the 1.25x price. Those rows hold ~69% of all Anthropic spend, so leaving them
-- understated the ledger by $13.57 against the invoice.
--
-- IDEMPOTENT: only rows differing from the correct figure are touched.

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
     -- cache read = 0.1x input; cache write = 2x input at the 1h TTL
     + cache_read_tokens  * CASE WHEN model LIKE '%haiku%'  THEN 1.0
                                 WHEN model LIKE '%sonnet%' THEN 3.0
                                 WHEN model LIKE '%opus%'   THEN 5.0 END * 0.1
     + cache_write_tokens * CASE WHEN model LIKE '%haiku%'  THEN 1.0
                                 WHEN model LIKE '%sonnet%' THEN 3.0
                                 WHEN model LIKE '%opus%'   THEN 5.0 END * 2.0
      ) / 1000000.0,
      6
    ) AS correct_cost
  FROM public.ai_usage
  WHERE provider = 'anthropic'
    AND (cache_read_tokens > 0 OR cache_write_tokens > 0)
    AND model IS NOT NULL
    AND (model LIKE '%haiku%' OR model LIKE '%sonnet%' OR model LIKE '%opus%')
) AS c
WHERE u.id = c.id
  AND u.cost_usd IS DISTINCT FROM c.correct_cost;
