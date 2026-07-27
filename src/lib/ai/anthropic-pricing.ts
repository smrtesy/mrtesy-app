/**
 * Anthropic token prices for the NEXT.JS app (route handlers).
 *
 * MIRROR NOTE — there are exactly three copies of this table, one per build
 * boundary, because none of the three can import from the others:
 *   1. `supabase/functions/_shared/ai-pricing.ts`  (Deno edge functions)
 *   2. `server/src/anthropic.ts`                   (Express backend)
 *   3. this file                                   (Next.js app)
 * A rate change MUST be applied to all three in the same commit. The whole
 * class of bug this guards against: on 2026-07-26 the rates were corrected in
 * only some copies, and the ledger quietly drifted away from the invoice.
 *
 * Rates from platform.claude.com/docs/en/about-claude/pricing (USD per 1M):
 *   Haiku 4.5 $1/$5 · Sonnet 4.6 $3/$15 · Opus 4.7–5 $5/$25
 */

export type CacheTtl = "5m" | "1h";

const FAMILY_RATES = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
} as const;

/** Cache rates are fixed multipliers of input, identical for every model. */
const CACHE_WRITE_MULT: Record<CacheTtl, number> = { "5m": 1.25, "1h": 2 };
const CACHE_READ_MULT = 0.1;

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** Substring match, so a newer model id never silently prices at $0. */
function familyFor(model: string): keyof typeof FAMILY_RATES {
  if (model.includes("haiku")) return "haiku";
  if (model.includes("opus")) return "opus";
  return "sonnet";
}

/**
 * Cost in USD for one Messages API call.
 *
 * `usage.input_tokens` is already the uncached remainder, so the cache counts
 * are ADDED, never subtracted again.
 *
 * @param cacheTtl must match the ttl on the request's cache_control block.
 */
export function anthropicCostUsd(
  model: string,
  usage: AnthropicUsage | null | undefined,
  cacheTtl: CacheTtl = "5m",
): number {
  if (!usage) return 0;
  const rate = FAMILY_RATES[familyFor(model)];
  return (
    ((usage.input_tokens ?? 0) * rate.input +
      (usage.output_tokens ?? 0) * rate.output +
      (usage.cache_read_input_tokens ?? 0) * rate.input * CACHE_READ_MULT +
      (usage.cache_creation_input_tokens ?? 0) * rate.input * CACHE_WRITE_MULT[cacheTtl]) /
    1_000_000
  );
}
