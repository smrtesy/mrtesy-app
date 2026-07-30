/**
 * Incremental index worker — drains search_index_queue (filled by the DB
 * triggers) and (re)indexes each changed row into search_documents. Invoked
 * every minute by pg_cron via POST /api/search/index/drain.
 *
 * Bounded per run (limit) so a drain always finishes well under a minute; a
 * backlog just carries to the next tick. An item that errors is LEFT in the
 * queue to retry; an item whose row is gone ("missing") is cleared.
 *
 * Race guard: the queue row is deleted only if its enqueued_at is unchanged
 * since we read it — so a re-enqueue that lands mid-processing is not lost, it
 * simply gets picked up again next drain.
 */

import { db } from "../../../db";
import { indexOneTask, indexOneInfo, indexOneClaudeThread, type IndexOneResult } from "./indexer";

interface QueueRow {
  source_type: string;
  source_id: string;
  enqueued_at: string;
}

export interface DrainResult {
  processed: number;
  missing: number;
  failed: number;
  skipped?: boolean;
}

// In-process guard against overlapping drains. pg_cron's net.http_post is
// fire-and-forget, so the next minute's tick can fire while this drain is still
// running; two overlapping drains would both embed the same rows (wasted Voyage
// cost — the enqueued_at guard prevents corruption, not the double call). One
// backend process serves the cron, so a module-level flag dedupes it. (A
// multi-instance deployment would need a pg advisory lock instead.)
let draining = false;

export async function drainQueue(limit = 100): Promise<DrainResult> {
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
    .select("source_type, source_id, enqueued_at")
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

  for (const r of rows) {
    let res: IndexOneResult;
    if (r.source_type === "task") res = await indexOneTask(r.source_id);
    else if (r.source_type === "info") res = await indexOneInfo(r.source_id);
    else if (r.source_type === "claude_thread") res = await indexOneClaudeThread(r.source_id);
    else res = "missing"; // unknown source_type → just drop it from the queue

    // "error" (DB failure) and "embed_failed" (Voyage transient) both stay in
    // the queue so the row gets a real embedding on a later drain instead of
    // being left semantically unsearchable.
    if (res === "error" || res === "embed_failed") {
      failed++;
      continue;
    }
    if (res === "missing") missing++;
    else processed++;

    const { error: delErr } = await db
      .from("search_index_queue")
      .delete()
      .eq("source_type", r.source_type)
      .eq("source_id", r.source_id)
      .eq("enqueued_at", r.enqueued_at); // only if not re-enqueued mid-processing
    if (delErr) console.error("[search/worker] queue delete failed:", delErr.message);
  }

  return { processed, missing, failed };
}
