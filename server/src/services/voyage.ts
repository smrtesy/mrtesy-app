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
  const slots: number[] = [];
  const inputs: string[] = [];
  texts.forEach((t, i) => {
    const trimmed = (t ?? "").trim();
    if (trimmed) {
      slots.push(i);
      inputs.push(trimmed.slice(0, 16000));
    }
  });
  if (inputs.length === 0) return results;

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: inputs, input_type: inputType }),
    });
    if (!resp.ok) return results; // whole batch failed → all null (caller retries)

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
  } catch {
    return results;
  }
}
