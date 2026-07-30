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
import { backfillAll } from "./indexer";

const router = Router();

function cronSecretOk(req: Request): boolean {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  return !!expected && req.headers["x-cron-secret"] === expected;
}

router.post("/search/index/drain", async (req: Request, res: Response) => {
  if (!cronSecretOk(req)) return res.status(403).json({ error: "Forbidden" });

  const capRaw = (req.body ?? {}).limit;
  const limit = typeof capRaw === "number" && capRaw > 0 && capRaw <= 1000 ? capRaw : undefined;

  const result = await drainQueue(limit);
  return res.json({ ok: true, ...result });
});

// One-time history seed for the whole instance (no JWT — cron-secret only), so
// the initial backfill can run with a single curl instead of a super-admin
// session. After this the DB triggers keep the index fresh incrementally.
router.post("/search/index/backfill", async (req: Request, res: Response) => {
  if (!cronSecretOk(req)) return res.status(403).json({ error: "Forbidden" });

  const capRaw = (req.body ?? {}).cap;
  const cap = typeof capRaw === "number" && capRaw > 0 && capRaw <= 5000 ? capRaw : undefined;

  const result = await backfillAll(cap);
  return res.json({ ok: true, indexed: result });
});

export default router;
