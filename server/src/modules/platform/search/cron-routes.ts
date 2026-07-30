/**
 * Global search — machine-to-machine index drain (x-cron-secret gated, no JWT).
 *
 * pg_cron POSTs here every minute (see migration 20260730140000). It drains a
 * bounded batch of search_index_queue, embedding each changed row and upserting
 * it into search_documents so the index stays fresh automatically.
 *
 * Auth model mirrors /info/extract/batch and /sync/run-scheduled: a shared
 * secret lets the scheduler act without a JWT. Mounted BEFORE the auth-guarded
 * routers.
 */

import { Router, type Request, type Response } from "express";
import { drainQueue } from "./worker";

const router = Router();

router.post("/search/index/drain", async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const capRaw = (req.body ?? {}).limit;
  const limit = typeof capRaw === "number" && capRaw > 0 && capRaw <= 1000 ? capRaw : undefined;

  const result = await drainQueue(limit);
  return res.json({ ok: true, ...result });
});

export default router;
