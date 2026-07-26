import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface AiUsageMeta {
  /** Coarse component label, e.g. "server.action", "server.router". */
  component: string;
  userId?: string;
  refId?: string;
}

/** Write one row to the unified ai_usage ledger. Best-effort: never throws. */
async function logAiUsage(
  modelId: string,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
  costUsd: number,
  meta?: AiUsageMeta,
): Promise<void> {
  try {
    await db.from("ai_usage").insert({
      user_id: meta?.userId ?? null,
      provider: "anthropic",
      component: meta?.component ?? "server.other",
      model: modelId,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      cost_usd: costUsd,
      ref_id: meta?.refId ?? null,
    });
  } catch {
    /* ledger insert must never break a request */
  }
}

export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  // Opus 4.7 → Opus 5: same list price ($5/$25 per 1M), newer model.
  opus: "claude-opus-5",
} as const;

export type ModelKey = keyof typeof MODELS;

interface CachedCallOptions {
  model: ModelKey;
  systemPrompt: string;
  /** Additional context loaded once per run (e.g. rules). Also cached. */
  rulesContext?: string;
  userMessage: string;
  maxTokens?: number;
}

interface CachedCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

// Token cost table (USD per 1M tokens). Verified against
// platform.claude.com/docs/en/about-claude/pricing on 2026-07-26.
// cacheWrite = 1.25× input (5-minute TTL); cacheRead = 0.1× input.
// Previous values were wrong on two rows: Haiku carried Haiku-3.5 prices
// ($0.8/$4) and Opus carried Opus-4.1 prices ($15/$75), so Haiku spend was
// under-reported ~25% and Opus over-reported 3×.
const COST = {
  "claude-haiku-4-5-20251001":   { input: 1,    output: 5,    cacheWrite: 1.25, cacheRead: 0.1  },
  "claude-sonnet-4-6":           { input: 3,    output: 15,   cacheWrite: 3.75, cacheRead: 0.3  },
  "claude-opus-5":               { input: 5,    output: 25,   cacheWrite: 6.25, cacheRead: 0.5  },
  // Older Opus ids stay listed: they are still selectable in smrtVoice
  // settings, and an unlisted id used to price at $0.
  "claude-opus-4-8":             { input: 5,    output: 25,   cacheWrite: 6.25, cacheRead: 0.5  },
  "claude-opus-4-7":             { input: 5,    output: 25,   cacheWrite: 6.25, cacheRead: 0.5  },
} as const;

type Pricing = { input: number; output: number; cacheWrite: number; cacheRead: number };

/** Per-family rates, used when an exact model id is not in COST. */
const FAMILY_COST: Record<"haiku" | "sonnet" | "opus", Pricing> = {
  haiku:  { input: 1, output: 5,  cacheWrite: 1.25, cacheRead: 0.1 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  opus:   { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

/**
 * Resolve pricing for a model id. Falls back to the family rate for ids not in
 * COST, so pointing MODELS at a newer model never silently logs $0 spend.
 */
function pricingFor(model: string): Pricing | null {
  const exact = COST[model as keyof typeof COST];
  if (exact) return exact;
  if (model.includes("haiku"))  return FAMILY_COST.haiku;
  if (model.includes("opus"))   return FAMILY_COST.opus;
  if (model.includes("sonnet")) return FAMILY_COST.sonnet;
  return null;
}

function estimateCost(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  const pricing = pricingFor(model);
  if (!pricing) return 0;
  const read   = (usage.cache_read_input_tokens ?? 0) / 1_000_000 * pricing.cacheRead;
  const write  = (usage.cache_creation_input_tokens ?? 0) / 1_000_000 * pricing.cacheWrite;
  // usage.input_tokens is ALREADY the uncached remainder — the full prompt is
  // input_tokens + cache_creation_input_tokens + cache_read_input_tokens. The
  // previous version subtracted the cache counts a second time, which drove
  // this term negative and under-reported cost on every cached call. Dormant
  // until now only because no server path set cache_control.
  const input  = usage.input_tokens / 1_000_000 * pricing.input;
  const output = usage.output_tokens / 1_000_000 * pricing.output;
  return read + write + input + output;
}

/**
 * Call Claude with prompt caching enabled.
 * The system prompt and optional rulesContext are marked cache_control=ephemeral,
 * so repeated calls within 5 minutes re-use the cached blocks (~90% cost saving).
 */
export async function cachedCall(opts: CachedCallOptions, meta?: AiUsageMeta): Promise<CachedCallResult> {
  const modelId = MODELS[opts.model];

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: opts.systemPrompt,
      // @ts-expect-error cache_control is supported but not yet in official TS types
      cache_control: { type: "ephemeral" },
    },
  ];

  if (opts.rulesContext) {
    systemBlocks.push({
      type: "text",
      text: opts.rulesContext,
      // @ts-expect-error
      cache_control: { type: "ephemeral" },
    });
  }

  const response = await client.messages.create({
    model: modelId,
    max_tokens: opts.maxTokens ?? 1024,
    system: systemBlocks,
    messages: [{ role: "user", content: opts.userMessage }],
  });

  const usage = response.usage as typeof response.usage & {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  const content = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  const costUsd = estimateCost(modelId, usage);
  await logAiUsage(modelId, usage, costUsd, meta);
  return {
    content,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd,
  };
}

export interface SimpleCallOptions {
  /**
   * Mark the system prompt with cache_control (1h TTL) so repeated calls that
   * share it byte-for-byte read it back at 0.1× input price instead of paying
   * full price every time.
   *
   * Opt-in per call site, deliberately. It pays off only when the prompt is a
   * large, STABLE prefix reused across several calls close together:
   *   - Below the model's minimum cacheable prefix (1024 tokens on Sonnet 4.6 /
   *     Sonnet 5, 4096 on Haiku 4.5) nothing is cached and nothing is charged
   *     extra — it silently does nothing.
   *   - Above it, the first call pays a 2× write premium, so the break-even is
   *     the 3rd call sharing the prefix within the hour. A large prompt that is
   *     unique per call would be a net LOSS, which is why this is not the
   *     default for all 30 simpleCall sites.
   */
  cacheSystem?: boolean;
}

/** One-off call. Pass `{ cacheSystem: true }` to cache a large stable prompt. */
export async function simpleCall(
  model: ModelKey,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 2048,
  meta?: AiUsageMeta,
  opts?: SimpleCallOptions,
): Promise<{ content: string; costUsd: number }> {
  const modelId = MODELS[model];
  // Cast: older @anthropic-ai/sdk type defs omit cache_control on text blocks,
  // so go through unknown to stay compilable across SDK versions.
  const system = opts?.cacheSystem
    ? ([{
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral", ttl: "1h" },
      }] as unknown as Anthropic.TextBlockParam[])
    : systemPrompt;
  const response = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userMessage }],
  });

  const content = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  const costUsd = estimateCost(modelId, response.usage);
  await logAiUsage(modelId, response.usage, costUsd, meta);
  return { content, costUsd };
}

/** Parse JSON from Claude output, handling markdown code fences */
export function parseJsonResponse<T>(raw: string): T | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  const direct = tryParseJson<T>(cleaned);
  if (direct !== null) return direct;
  // The model sometimes wraps the JSON in prose ("Here's the action:") or
  // stray fences. Fall back to the first balanced {...} / [...] value.
  const extracted = extractBalancedJson(cleaned);
  return extracted ? tryParseJson<T>(extracted) : null;
}

function tryParseJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function extractBalancedJson(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}
