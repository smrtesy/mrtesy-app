/**
 * smrtStudio — scheduled job routes (same shape as smrtPlan's).
 *
 * pg_cron (via pg_net) calls this bounded endpoint weekly so the fal catalog
 * refreshes itself. Shared-secret guarded and mounted BEFORE the auth chain,
 * because a cron has no session, no org header and no super-admin to check.
 *
 *   /api/studio/jobs/sweep — re-read fal's catalog and any unread schemas
 *
 * Why weekly and why automatic: fal publishes models continuously, and until
 * now the catalog only learned about them when a human happened to press a
 * button. A shelf that is only as fresh as the last time someone remembered is
 * not a catalog. The sweep is FREE — it reads fal's catalog and OpenAPI
 * endpoints, never an inference endpoint — so running it on a schedule costs
 * nothing and needs no cost approval.
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { db } from "../../db";
import { sweepToCompletion, SweepError } from "./sweep";

const router = Router();

function secretOk(req: Request): boolean {
  const expected = process.env.SMRTSTUDIO_INTERNAL_SECRET || process.env.CRON_SECRET || "";
  // No secret configured means the route is CLOSED, never open. An unset env
  // var must not be the thing that exposes a catalog rewrite.
  return !!expected && req.get("x-cron-secret") === expected;
}

router.use("/api/studio/jobs", (req: Request, res: Response, next: NextFunction) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  next();
});

router.post("/api/studio/jobs/sweep", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const probeLimit = Number(body.probe_limit ?? 150);

  // Every org entitled to smrtstudio. The catalog is per-org (studio_models is
  // org-scoped), so a single global sweep would refresh one tenant and leave
  // the rest stale.
  const { data: apps, error: appErr } = await db
    .from("apps")
    .select("id")
    .eq("slug", "smrtstudio")
    .limit(1);
  if (appErr) return res.status(500).json({ error: appErr.message });
  const appId = apps?.[0]?.id;
  if (!appId) return res.json({ ok: true, orgs: 0, note: "smrtstudio app not registered" });

  const { data: memberships, error: memErr } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("app_id", appId);
  if (memErr) return res.status(500).json({ error: memErr.message });

  const orgIds = [...new Set((memberships ?? []).map((m) => String(m.org_id)).filter(Boolean))];
  const results: Record<string, unknown>[] = [];
  for (const orgId of orgIds) {
    try {
      const r = await sweepToCompletion(orgId, { probeLimit });
      results.push({
        org_id: orgId,
        ok: true,
        catalog_total: r.catalog_total,
        catalog_incomplete: r.catalog_incomplete,
        probed: r.audio_probed_total_this_run,
        complete: r.complete,
        stopped_because: r.stopped_because,
      });
    } catch (e) {
      // One org's failure must not abort the others — reported per org so a
      // partial run is visible instead of looking like a total failure.
      results.push({
        org_id: orgId,
        ok: false,
        status: e instanceof SweepError ? e.status : 500,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  res.json({ ok: results.every((r) => r.ok), orgs: orgIds.length, results });
});

export default router;
