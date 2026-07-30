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
import { timingSafeEqual as cryptoTimingSafeEqual } from "crypto";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { db } from "../../db";
import { sweepToCompletion, SweepError } from "./sweep";
import { pollSubmittedRuns, settleRun } from "./runner";

const router = Router();

/**
 * POST /api/studio/jobs/fal-webhook?run=<id>&token=<t> — fal's completion
 * callback. Registered BEFORE the shared-secret guard on purpose: fal cannot
 * send x-cron-secret. Auth is the per-run token minted at submit and stored
 * in the run's meta — a guess must match both a run UUID and its token. The
 * webhook body is untrusted and IGNORED: we only take the wake-up, then read
 * status+result from fal's API directly (settleRun), so a forged call can at
 * worst trigger a read of the real state.
 */
router.post("/api/studio/jobs/fal-webhook", async (req: Request, res: Response) => {
  const runId = String(req.query.run ?? "");
  const token = String(req.query.token ?? "");
  if (!runId || !token) return res.status(400).json({ error: "missing run/token" });
  const { data: run } = await db.from("experiment_runs")
    .select("id, meta").eq("id", runId).maybeSingle();
  const expected = (run?.meta as Record<string, unknown> | null)?.webhook_token;
  const tokenOk =
    typeof expected === "string" && expected.length > 0 &&
    expected.length === token.length &&
    cryptoTimingSafeEqual(Buffer.from(expected), Buffer.from(token));
  if (!run || !tokenOk) {
    return res.status(404).json({ error: "unknown run" });
  }
  await settleRun(runId);
  res.json({ ok: true });
});

function secretOk(req: Request): boolean {
  // SMRTBOT_INTERNAL_SECRET is in the chain because it is what Railway
  // actually provisions today (CLAUDE.md). Leaving it out meant the weekly
  // cron would 401 forever, silently, until someone added a brand-new env var
  // nobody knew was required.
  const expected =
    process.env.SMRTSTUDIO_INTERNAL_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SMRTBOT_INTERNAL_SECRET ||
    "";
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
  // ONE deadline for the whole call, shared across orgs. A per-org budget
  // multiplies: five orgs at nine minutes each is 45 minutes against the
  // migration's 10-minute `timeout_milliseconds`, so pg_net would record a
  // timeout and the cron would never get a success signal even when the work
  // was fine. Each org gets whatever is left.
  const until = Date.now() + 9 * 60_000;
  for (const orgId of orgIds) {
    const left = until - Date.now();
    if (left <= 0) {
      results.push({ org_id: orgId, ok: true, skipped: "deadline" });
      continue;
    }
    try {
      const r = await sweepToCompletion(orgId, { probeLimit, deadlineMs: left });
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

/**
 * POST /api/studio/jobs/consult-answer — the expert session's write-back
 * (stage F). A manual /expert session (video-lab) diagnoses a filed
 * consultation and posts its structured answer here; the project screen then
 * renders the solutions as checkboxes → estimate → "אשר והרץ".
 *
 * Machine-to-machine (cron-secret guarded like the sweep). The answer must
 * carry the contract shape: { diagnosis: string, solutions: [{title, ...}],
 * rejected?: [...] } — a malformed answer is refused, never half-stored.
 */
router.post("/api/studio/jobs/consult-answer", async (req: Request, res: Response) => {
  const id = String(req.body?.consultation_id ?? "");
  const answer = req.body?.answer as Record<string, unknown> | undefined;
  if (!id || !answer || typeof answer !== "object") {
    return res.status(400).json({ error: "consultation_id and answer are required" });
  }
  if (typeof answer.diagnosis !== "string" || !answer.diagnosis.trim()) {
    return res.status(400).json({ error: "answer.diagnosis (string) is required" });
  }
  const solutions = answer.solutions;
  if (!Array.isArray(solutions) || solutions.length === 0 ||
      solutions.some((s) => !s || typeof s !== "object" || typeof (s as Record<string, unknown>).title !== "string")) {
    return res.status(400).json({ error: "answer.solutions must be a non-empty array of {title, ...}" });
  }

  const { data: consult, error } = await db.from("studio_consultations")
    .select("id, status").eq("id", id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!consult) return res.status(404).json({ error: "consultation not found" });
  // Re-answering an open/answered consultation refines it; an executed one is
  // history — a new problem gets a new consultation.
  if (consult.status !== "open" && consult.status !== "answered") {
    return res.status(409).json({ error: `consultation is ${consult.status} — file a new one` });
  }

  const { error: upErr } = await db.from("studio_consultations").update({
    answer,
    status: "answered",
    answered_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (upErr) return res.status(500).json({ error: upErr.message });
  res.json({ ok: true, consultation_id: id, status: "answered" });
});

/**
 * POST /api/studio/jobs/poll-runs — the webhook-loss safety net (cron, every
 * few minutes): sweep runs stuck in `submitted` and settle any that fal has
 * finished. Idempotent with the webhook; free (status reads only).
 */
router.post("/api/studio/jobs/poll-runs", async (_req: Request, res: Response) => {
  try {
    const swept = await pollSubmittedRuns();
    res.json({ ok: true, swept });
  } catch (e) {
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
