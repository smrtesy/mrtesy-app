import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
export async function cachedCall(opts: CachedCallOptions): Promise<CachedCallResult> {
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

  return {
    content,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costUsd: estimateCost(modelId, usage),
  };
}

/** Simple (non-cached) call for one-off actions */
export async function simpleCall(
  model: ModelKey,
  systemPrompt: string,
  userMessage: string,
  maxTokens = 2048,
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

  return { content, costUsd: estimateCost(modelId, response.usage) };
}

/** Parse JSON from Claude output, handling markdown code fences */
export function parseJsonResponse<T>(raw: string): T | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```\s*$/m, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}
