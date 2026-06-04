/**
 * smrtPlan — scheduled job routes (cron model ג3).
 *
 * pg_cron (via pg_net) calls this bounded endpoint; the engine recompute stays
 * here on the Railway server. Shared-secret guarded, mounted BEFORE the auth
 * chain (same pattern as the smrtBot job routes).
 *
 *   /api/plan/jobs/refresh — daily backward-scheduling + critical-path refresh
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { refreshAll } from "./engine";

const router = Router();

function secretOk(req: Request): boolean {
  const expected = process.env.SMRTPLAN_INTERNAL_SECRET || process.env.CRON_SECRET || "";
  return !!expected && req.get("x-smrtplan-secret") === expected;
}

router.use("/api/plan/jobs", (req: Request, res: Response, next) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  next();
});

router.post("/api/plan/jobs/refresh", async (_req: Request, res: Response) => {
  try {
    const summary = await refreshAll();
    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
