// Single source of truth for Anthropic token prices in the EDGE FUNCTIONS.
//
// WHY THIS FILE EXISTS: the price table used to be copy-pasted into every
// function that calls the Messages API (ai-process, drive-sync,
// project-detection, quick-action) plus the Express server. When the rates were
// corrected on 2026-07-26 only two of the five copies were updated, so
// `drive_ocr` and `project_detection` kept billing at Haiku-3.5's $0.80/$4 and
// `quick_action` kept pricing every model at Sonnet's $3/$15. The ledger drifted
// from the invoice and nobody noticed, because each copy looked locally correct.
// One table, imported everywhere, is the only way that stops happening.
//
// MIRROR NOTE: `server/src/anthropic.ts` holds the identical table for the
// Express backend (it cannot import from `supabase/functions/`, which is Deno).
// Any rate change here MUST be applied there in the same commit.
//
// Rates verified against platform.claude.com/docs/en/about-claude/pricing
// (USD per 1M tokens):
//   Haiku 4.5    $1 / $5
//   Sonnet 4.6   $3 / $15
//   Opus 4.7–5   $5 / $25

export type AnthropicFamily = "haiku" | "sonnet" | "opus";

/** The TTL the CALLER asked for on its cache_control block. */
export type CacheTtl = "5m" | "1h";

const FAMILY_RATES: Record<AnthropicFamily, { input: number; output: number }> = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
};

/**
 * Cache prices are fixed multipliers of the model's INPUT rate, identical for
 * every model — so they are derived, never listed. A hand-written cache column
 * is exactly how the old tables drifted: a 1h write priced at the 5m rate
 * under-reports that write by 37.5%.
 */
const CACHE_WRITE_MULT: Record<CacheTtl, number> = { "5m": 1.25, "1h": 2 };
const CACHE_READ_MULT = 0.1;

/**
 * Map a model id to its price family. Substring matching (not an exact-id
 * lookup) is deliberate: pointing a model constant at a newer id must never
 * silently log $0 spend, which is what an unlisted exact id used to do.
 */
export function anthropicFamily(model: string): AnthropicFamily {
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus")) return "opus";
  return "sonnet";
}

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Cost in USD for one Messages API call.
 *
 * `usage.input_tokens` is ALREADY the uncached remainder — the full prompt is
 * input_tokens + cache_creation_input_tokens + cache_read_input_tokens. Do NOT
 * subtract the cache counts again; that drives the input term negative and
 * under-reports every cached call.
 *
 * @param cacheTtl must match the ttl on the request's cache_control block, or
 * the ledger silently drifts from the invoice.
 */
export function anthropicCostUsd(
  model: string,
  usage: AnthropicUsage | null | undefined,
  cacheTtl: CacheTtl = "5m",
): number {
  if (!usage) return 0;
  const rate = FAMILY_RATES[anthropicFamily(model)];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.input * CACHE_READ_MULT +
      cacheWrite * rate.input * CACHE_WRITE_MULT[cacheTtl]) /
    1_000_000
  );
}

/** Token-count variant, for call sites that already destructured the counts. */
export function anthropicCostUsdFromCounts(
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  cacheTtl: CacheTtl = "5m",
): number {
  return anthropicCostUsd(
    model,
    {
      input_tokens: input,
      output_tokens: output,
      cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cacheWrite,
    },
    cacheTtl,
  );
}
