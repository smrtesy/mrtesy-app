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
  opus: "claude-opus-4-7",
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

// Rough token cost table (USD per 1M tokens) — update as pricing changes
const COST = {
  "claude-haiku-4-5-20251001":   { input: 0.8,  output: 4,    cacheWrite: 1,    cacheRead: 0.08 },
  "claude-sonnet-4-6":           { input: 3,    output: 15,   cacheWrite: 3.75, cacheRead: 0.3  },
  "claude-opus-4-7":             { input: 15,   output: 75,   cacheWrite: 18.75,cacheRead: 1.5  },
} as const;

function estimateCost(model: string, usage: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): number {
  const pricing = COST[model as keyof typeof COST];
  if (!pricing) return 0;
  const read   = (usage.cache_read_input_tokens ?? 0) / 1_000_000 * pricing.cacheRead;
  const write  = (usage.cache_creation_input_tokens ?? 0) / 1_000_000 * pricing.cacheWrite;
  const input  = (usage.input_tokens - (usage.cache_read_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0)) / 1_000_000 * pricing.input;
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

/** Simple (non-cached) call for one-off actions */
export async function simpleCall(
  model: ModelKey,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 2048,
  meta?: AiUsageMeta,
): Promise<{ content: string; costUsd: number }> {
  const modelId = MODELS[model];
  const response = await client.messages.create({
    model: modelId,
    max_tokens: maxTokens,
    system: systemPrompt,
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
