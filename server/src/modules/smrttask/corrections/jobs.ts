/**
 * Correction triage — scheduled recovery route.
 *
 * pg_cron (via pg_net) calls this bounded endpoint so a triage that was lost
 * gets picked up. Shared-secret guarded and mounted BEFORE the auth chain,
 * because a cron has no session, no org header and no super-admin to check.
 * Same shape as smrtStudio's and smrtPlan's job routes.
 *
 *   /api/corrections/jobs/triage-sweep — triage corrections that have no verdict
 *
 * WHY IT IS NOT OPTIONAL
 * POST /corrections fires triage without awaiting it, so the user gets their 201
 * immediately. The cost is a window: a redeploy or a crash during the run loses
 * that triage with nothing to notice — the correction keeps no class, the
 * classifier's allow-list keeps it out of the prompt, and the notification that
 * was supposed to tell the user never arrives. The whole design rests on the
 * claim that "did not enter the prompt" always reaches the user as a message
 * rather than as silence, and without this sweep that claim depends on the API
 * process never restarting at the wrong moment.
 *
 * FREE: the sweep runs the Claude Code CLI on the user's subscription
 * (CLAUDE_CODE_OAUTH_TOKEN), zero paid API tokens, so a schedule needs no cost
 * approval. It shares triage's single-slot queue, so it can never starve a live
 * correction — it just waits its turn.
 */
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { sweepUntriagedCorrections } from "./triage";

const router = Router();

function secretOk(req: Request): boolean {
  // SMRTBOT_INTERNAL_SECRET is in the chain because it is what Railway actually
  // provisions today (CLAUDE.md), so leaving it out would make the cron 401
  // forever, silently.
  const expected =
    process.env.CRON_SECRET ||
    process.env.SMRTBOT_INTERNAL_SECRET ||
    "";
  // No secret configured means the route is CLOSED, never open.
  return !!expected && req.get("x-cron-secret") === expected;
}

router.use("/api/corrections/jobs", (req: Request, res: Response, next: NextFunction) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  next();
});

router.post("/api/corrections/jobs/triage-sweep", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const limit = Number(body.limit ?? 5);

  try {
    // Awaited on purpose, unlike the create path: a cron wants a real result, and
    // the bounded limit keeps the request short. The one-slot queue serializes
    // these behind any live triage.
    const swept = await sweepUntriagedCorrections(Number.isFinite(limit) ? limit : 5);
    return res.json({ ok: true, swept });
  } catch (e) {
    console.error("[corrections.jobs] sweep failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "sweep_failed" });
  }
});

export default router;
