/**
 * Voyage AI embeddings wrapper.
 *
 * Turns text into a 1024-dim vector so the knowledge base can find a
 * semantically-similar question regardless of wording or language. One REST
 * call per text; every call writes a row to the unified `ai_usage` ledger
 * (provider = "voyage") so embedding spend reconciles against the Voyage bill.
 *
 * If VOYAGE_API_KEY is unset the whole feature degrades gracefully: embedText
 * returns null and callers skip knowledge-base lookup/save without erroring.
 */

import { db } from "../db";

const MODEL = "voyage-4";
const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

// USD per 1M tokens for voyage-4 (docs.voyageai.com/docs/pricing — update if it
// changes). First 200M tokens/account are free, so this is usually a no-op cost.
const COST_PER_1M = 0.06;

export const EMBED_DIM = 1024;

// Last batch-embed failure reason (status + short body), surfaced so the drain
// endpoint can echo WHY Voyage rejected a batch (Railway logs aren't reachable
// from the DB side). Diagnostic only.
let lastEmbedError: string | null = null;

// ── Free-tier throttle ───────────────────────────────────────────────────────
// A Voyage account with no payment method is capped at 3 requests/min and 10K
// tokens/min. The indexer drains every minute in chunks, so it blew past 3 RPM,
// every call 429'd, every row came back with a null embedding and was re-queued
// — the backlog never drained and new content stopped getting vectors. We now
// stay UNDER the free limits instead of hammering: at most MAX_RPM requests per
// rolling minute, a bounded character budget per request (≈4 chars/token, so
// 12K chars ≈ 3K tokens — three of those fit inside 10K TPM), and a cooldown
// after a 429 so a burst can't re-trigger it. Anything not embedded this tick
// is simply left for the next one.
const MAX_RPM = 3;
const MAX_CHARS_PER_REQUEST = 12_000;
const COOLDOWN_MS = 70_000;
let requestTimes: number[] = [];
let cooldownUntil = 0;
// True when the LAST embed call made no request at all because we were cooling
// down or out of rate budget. The caller must not count that as a failed
// attempt for the rows involved — nothing was actually tried for them.
let lastEmbedDeferred = false;

/** Did the last embedTexts() skip the API entirely (cooldown / rate budget)? */
export function wasLastEmbedDeferred(): boolean {
  return lastEmbedDeferred;
}

/** Requests still counting against the rolling-minute window. */
function recentRequests(now: number): number {
  requestTimes = requestTimes.filter((t) => now - t < 60_000);
  return requestTimes.length;
}

export function getLastEmbedError(): string | null {
  return lastEmbedError;
}

interface VoyageResponse {
  data?: { embedding: number[]; index?: number }[];
  usage?: { total_tokens?: number };
}

async function logVoyageUsage(totalTokens: number, userId?: string, refId?: string): Promise<void> {
  try {
    await db.from("ai_usage").insert({
      user_id: userId ?? null,
      provider: "voyage",
      component: "server.embed",
      model: MODEL,
      input_tokens: totalTokens,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: (totalTokens / 1_000_000) * COST_PER_1M,
      ref_id: refId ?? null,
    });
  } catch {
    /* ledger insert must never break a request */
  }
}

/**
 * Embed a single piece of text. `inputType` should be "query" for an incoming
 * question being looked up, and "document" for a stored answer's question —
 * Voyage tunes the vector slightly per side, improving retrieval quality.
 * Returns null when the key is missing or the API call fails.
 */
export async function embedText(
  text: string,
  inputType: "query" | "document",
  meta?: { userId?: string; refId?: string },
): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: trimmed.slice(0, 16000),
        input_type: inputType,
      }),
    });

    if (!resp.ok) return null;

    const json = (await resp.json()) as VoyageResponse;
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length !== EMBED_DIM) return null;

    await logVoyageUsage(json.usage?.total_tokens ?? 0, meta?.userId, meta?.refId);
    return embedding;
  } catch {
    return null;
  }
}

/**
 * Embed MANY texts in a SINGLE Voyage request (the API accepts an array), so a
 * bulk index pass costs ~1 request per batch instead of one per item — the
 * difference between minutes and days when the account is rate-limited.
 *
 * Returns an array aligned 1:1 with `texts`: each entry is the embedding, or
 * null when that text was empty, the whole call failed, or the key is unset.
 * Empty texts are skipped from the request but still occupy their null slot, so
 * the caller can map results straight back by index.
 */
export async function embedTexts(
  texts: string[],
  inputType: "query" | "document",
  meta?: { userId?: string; refId?: string },
): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = texts.map(() => null);
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return results;

  // Only send non-empty texts; remember each one's slot in the original array.
  // Respect the free tier BEFORE spending a request: a 429 costs the whole
  // batch, so skipping this tick is strictly better than being rejected.
  const now = Date.now();
  lastEmbedDeferred = false;
  if (now < cooldownUntil) {
    lastEmbedDeferred = true;
    lastEmbedError = `voyage cooling down for ${Math.ceil((cooldownUntil - now) / 1000)}s after a rate-limit`;
    return results;
  }
  if (recentRequests(now) >= MAX_RPM) {
    lastEmbedDeferred = true;
    lastEmbedError = `voyage rate budget spent (${MAX_RPM}/min) — deferring to the next tick`;
    return results;
  }

  const slots: number[] = [];
  const inputs: string[] = [];
  let budget = MAX_CHARS_PER_REQUEST;
  texts.forEach((t, i) => {
    const trimmed = (t ?? "").trim();
    if (!trimmed || budget <= 0) return; // over budget → left for the next tick
    const clipped = trimmed.slice(0, Math.min(16000, budget));
    budget -= clipped.length;
    slots.push(i);
    inputs.push(clipped);
  });
  if (inputs.length === 0) return results;

  requestTimes.push(now);

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: inputs, input_type: inputType }),
    });
    if (!resp.ok) {
      // Capture the reason so the drain endpoint can echo it (see getLastEmbedError).
      const body = await resp.text().catch(() => "");
      lastEmbedError = `voyage ${resp.status} (${inputs.length} inputs): ${body.slice(0, 300)}`;
      // Back off on a rate-limit so the next tick doesn't walk straight into
      // another 429 (which is what kept the queue stuck for four days).
      if (resp.status === 429) cooldownUntil = Date.now() + COOLDOWN_MS;
      return results; // whole batch failed → all null (caller retries)
    }

    lastEmbedError = null;
    const json = (await resp.json()) as VoyageResponse;
    for (let k = 0; k < (json.data?.length ?? 0); k++) {
      const item = json.data![k];
      // Voyage tags each vector with its index into `inputs`; fall back to order.
      const inputIdx = typeof item.index === "number" ? item.index : k;
      const emb = item.embedding;
      if (emb && emb.length === EMBED_DIM && slots[inputIdx] !== undefined) {
        results[slots[inputIdx]] = emb;
      }
    }
    await logVoyageUsage(json.usage?.total_tokens ?? 0, meta?.userId, meta?.refId);
    return results;
  } catch (e) {
    lastEmbedError = `voyage fetch threw: ${(e as Error).message}`.slice(0, 300);
    return results;
  }
}
