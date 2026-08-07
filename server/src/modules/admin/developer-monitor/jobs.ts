/**
 * Developer-access monitor — cron job route (x-cron-secret gated, no JWT).
 *
 * POST /api/developer-monitor/jobs/sweep — called every 5 min by pg_cron
 * (supabase/migrations/20260807190000_developer_access_monitor_cron.sql). Pulls
 * postgres_logs for the `developer` DB role, geo-locates new IPs, and writes
 * anomalies to log_entries. Design: docs/developer-access-monitor-plan.md.
 *
 * Mounted in server/index.ts BEFORE the auth guards, like the other job routers.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { runDeveloperAccessMonitor } from "./monitor";

const router = Router();

router.post("/api/developer-monitor/jobs/sweep", async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const result = await runDeveloperAccessMonitor();
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[dev-monitor] sweep failed:", e);
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
