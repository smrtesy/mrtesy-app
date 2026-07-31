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
import { db } from "../../../db";
import { DIAGNOSIS_TIMEOUT_MS } from "./diagnose";

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

// The auto-diagnosis run (diagnose.ts) POSTs its verdict here. Same secret gate
// as the sweeps (this path is under /api/corrections/jobs). The run_id in the
// body must match the one we recorded when spawning the run, so a stray POST
// cannot overwrite a correction's diagnosis.
router.post("/api/corrections/jobs/diagnosis/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const runId = typeof body.run_id === "string" ? body.run_id : "";

  const { data: row, error: findErr } = await db
    .from("task_corrections")
    .select("context")
    .eq("id", id)
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!row) return res.status(404).json({ error: "not_found" });

  const prev = (row.context ?? {}) as Record<string, unknown>;
  const prevDiag = (prev.diagnosis ?? {}) as Record<string, unknown>;
  // Anti-spoof: only the run we spawned may write this correction's diagnosis.
  if (!runId || prevDiag.run_id !== runId) {
    return res.status(409).json({ error: "run_mismatch" });
  }

  const risk = ["low", "med", "high"].includes(String(body.risk)) ? String(body.risk) : null;
  const files = Array.isArray(body.files)
    ? body.files.filter((f) => typeof f === "string").slice(0, 40)
    : [];
  const context = {
    ...prev,
    diagnosis: {
      ...prevDiag,
      status: "done",
      problem_he: String(body.problem_he ?? "").slice(0, 2000),
      fix_he: String(body.fix_he ?? "").slice(0, 2000),
      risk,
      files,
      ran_at: new Date().toISOString(),
    },
  };
  const { error: updErr } = await db
    .from("task_corrections")
    .update({ context, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (updErr) return res.status(500).json({ error: updErr.message });
  return res.json({ ok: true });
});

// Safety gate (user requirement): a diagnosis run that never posts back must not
// leave the correction stuck on "מאבחן…" forever. This flips any diagnosis that
// has been `running` longer than the timeout to `failed`, so the card surfaces
// "האבחון לא הצליח לרוץ" and the user can still act. Idempotent and bounded.
router.post("/api/corrections/jobs/diagnosis-sweep", async (_req: Request, res: Response) => {
  try {
    const { data: rows, error } = await db
      .from("task_corrections")
      .select("id, context")
      .eq("context->diagnosis->>status", "running")
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });

    const cutoff = Date.now() - DIAGNOSIS_TIMEOUT_MS;
    let failed = 0;
    for (const row of rows ?? []) {
      const prev = (row.context ?? {}) as Record<string, unknown>;
      const diag = (prev.diagnosis ?? {}) as Record<string, unknown>;
      const startedAt = Date.parse(String(diag.started_at ?? ""));
      if (!Number.isFinite(startedAt) || startedAt > cutoff) continue;
      const context = {
        ...prev,
        diagnosis: { ...diag, status: "failed", error: "timeout", ran_at: new Date().toISOString() },
      };
      const { error: updErr } = await db
        .from("task_corrections")
        .update({ context, updated_at: new Date().toISOString() })
        .eq("id", row.id as string);
      if (!updErr) failed += 1;
    }
    return res.json({ ok: true, failed });
  } catch (e) {
    console.error("[corrections.jobs] diagnosis-sweep failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "diagnosis_sweep_failed" });
  }
});

export default router;
