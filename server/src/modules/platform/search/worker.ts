/**
 * Incremental index worker — drains search_index_queue (filled by the DB
 * triggers) and (re)indexes each changed row into search_documents. Invoked
 * every minute by pg_cron via POST /api/search/index/drain.
 *
 * Batched: up to `limit` queue rows per tick, processed in chunks of EMBED_BATCH
 * that each cost ONE Voyage request (indexBatch). This is what makes a large
 * backlog (tens of thousands of rows) finish in minutes and survive Voyage rate
 * limits, instead of one request per row.
 *
 * An item that errors or whose embedding came back null is LEFT in the queue to
 * retry, up to MAX_ATTEMPTS — then it is dropped so it cannot stall the backlog
 * behind it (its TEXT is already indexed; only the vector is lost). An item
 * whose row is gone ("missing") is cleared.
 *
 * Race guard: a queue row is deleted only if its enqueued_at is unchanged since
 * we read it — so a re-enqueue that lands mid-processing is not lost.
 */

import { db } from "../../../db";
import { indexBatch, type IndexOneResult } from "./indexer";
import { wasLastEmbedDeferred } from "../../../services/voyage";

interface QueueRow {
  source_type: string;
  source_id: string;
  enqueued_at: string;
  /** Failed drain attempts so far (see MAX_ATTEMPTS). */
  attempts?: number | null;
}

export interface DrainResult {
  processed: number;
  missing: number;
  failed: number;
  skipped?: boolean;
}

// Texts per Voyage request. 100 × ~a few hundred tokens stays well under
// Voyage's per-request token ceiling.
const EMBED_BATCH = 32;

// Drop a row from the queue once it has failed this many drains. Bounded so a
// permanently-failing item (a source row the embedder always rejects, a text
// the API won't accept) can never stall the backlog behind it.
const MAX_ATTEMPTS = 5;

// In-process guard against overlapping drains. pg_cron's net.http_post is
// fire-and-forget, so the next minute's tick can fire while this drain is still
// running; one backend process serves the cron, so a module-level flag dedupes
// it. (A multi-instance deployment would need a pg advisory lock instead.)
let draining = false;

export async function drainQueue(limit = 500): Promise<DrainResult> {
  if (draining) return { processed: 0, missing: 0, failed: 0, skipped: true };
  draining = true;
  try {
    return await runDrain(limit);
  } finally {
    draining = false;
  }
}

async function runDrain(limit: number): Promise<DrainResult> {
  const { data, error } = await db
    .from("search_index_queue")
    .select("source_type, source_id, enqueued_at, attempts")
    .order("enqueued_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[search/worker] load queue failed:", error.message);
    return { processed: 0, missing: 0, failed: 0 };
  }

  const rows = (data ?? []) as QueueRow[];
  let processed = 0;
  let missing = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += EMBED_BATCH) {
    const chunk = rows.slice(i, i + EMBED_BATCH);
    const results = await indexBatch(
      chunk.map((r) => ({ source_type: r.source_type, source_id: r.source_id })),
    );

    for (const r of chunk) {
      const res: IndexOneResult = results.get(`${r.source_type}:${r.source_id}`) ?? "error";

      // "error" (fetch/upsert failure) and "embed_failed" (Voyage transient)
      // stay in the queue so the row is retried on a later drain — but only up
      // to MAX_ATTEMPTS. Without that cap a permanently-failing row is retried
      // every minute forever and, drained oldest-first, holds the whole backlog
      // behind it (exactly what stalled the index for four days on Voyage 429s).
      // Giving up costs only the vector: indexBatch already wrote the row's TEXT
      // to search_documents, so keyword search still finds it.
      if (res === "error" || res === "embed_failed") {
        failed++;
        // A chunk we never sent (Voyage cooldown / rate budget spent) is NOT a
        // failed attempt — nothing was tried for these rows. Counting it would
        // burn all 5 attempts in 5 minutes of throttling and drop the whole
        // backlog's vectors without ever asking for them.
        if (res === "embed_failed" && wasLastEmbedDeferred()) continue;
        const attempts = (r.attempts ?? 0) + 1;
        if (attempts < MAX_ATTEMPTS) {
          const { error: bumpErr } = await db
            .from("search_index_queue")
            .update({ attempts })
            .eq("source_type", r.source_type)
            .eq("source_id", r.source_id)
            .eq("enqueued_at", r.enqueued_at);
          if (bumpErr) console.error("[search/worker] attempts bump failed:", bumpErr.message);
          continue;
        }
        console.error(
          `[search/worker] giving up on ${r.source_type}:${r.source_id} after ${attempts} attempts (${res}) — text is indexed, vector is not`,
        );
        // fall through to the delete below so it stops blocking the queue
      }
      // Anything that reached here after failing MAX_ATTEMPTS was already
      // counted in `failed` — don't count it a second time as processed.
      if (res === "missing") missing++;
      else if (res !== "error" && res !== "embed_failed") processed++;

      const { error: delErr } = await db
        .from("search_index_queue")
        .delete()
        .eq("source_type", r.source_type)
        .eq("source_id", r.source_id)
        .eq("enqueued_at", r.enqueued_at); // only if not re-enqueued mid-processing
      if (delErr) console.error("[search/worker] queue delete failed:", delErr.message);
    }
  }

  return { processed, missing, failed };
}
