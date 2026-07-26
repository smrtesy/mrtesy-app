/**
 * Claude runs — the app's own API for launching and reading Claude runs.
 *
 * Standard chain: requireAuth → requireOrg → requireSuperAdmin. This is an
 * operator console, not a per-app feature, so it follows the admin-route
 * exception to requireApp("<slug>") rather than inventing an app slug for it.
 *
 *   POST /api/claude/runs      launch a run (returns immediately; it executes async)
 *   GET  /api/claude/runs      list this org's runs
 *   GET  /api/claude/runs/:id  one run + its full event stream
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { requireAuth, requireOrg, requireSuperAdmin } from "../../middleware";
import { executeRun } from "./runner";

const router = Router();
router.use(requireAuth, requireOrg, requireSuperAdmin);

const MAX_PROMPT = 20_000;
const MAX_TITLE = 200;
/** Events per run returned by the detail route — a long run can emit thousands. */
const EVENT_PAGE = 2000;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

router.post("/claude/runs", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = req.body ?? {};

  const prompt = str(body.prompt, MAX_PROMPT);
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // A run is identifiable even when the caller doesn't name it.
  const title = str(body.title, MAX_TITLE) || prompt.slice(0, 80);

  const { data, error } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      claude_account: str(body.claude_account, 320) || null,
      title,
      prompt,
      repo: str(body.repo, 200) || null,
      cwd: str(body.cwd, 500) || null,
      status: "queued",
    })
    .select("id, title, status, created_at")
    .single();

  if (error) {
    console.error("[claude/runs] insert failed:", error.message);
    return res.status(500).json({ error: "could not create run" });
  }

  // Fire and forget: the run's own status/events are the report, so the caller
  // gets an id immediately instead of holding the request open for minutes.
  // Slice 1 deliberately has no queue worker — see plan.md §7.
  void executeRun(data.id).catch((e) =>
    console.error("[claude/runs] executeRun threw:", e instanceof Error ? e.message : e),
  );

  return res.status(201).json({ run: data });
});

router.get("/claude/runs", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const { data, error } = await db
    .from("claude_runs")
    .select(
      "id, title, status, claude_account, repo, session_id, result_summary, error, started_at, ended_at, created_at",
    )
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[claude/runs] list failed:", error.message);
    return res.status(500).json({ error: "could not list runs" });
  }
  return res.json({ runs: data ?? [] });
});

/** Postgres rejects a malformed uuid with an error, which would surface as a 500
 *  for what is really a bad path param — screen it out and answer 404. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/claude/runs/:id", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "run not found" });

  // Scope the lookup by org so an id from another tenant reads as not-found.
  const { data: run, error: runError } = await db
    .from("claude_runs")
    .select("*")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();

  if (runError) {
    console.error("[claude/runs] fetch failed:", runError.message);
    return res.status(500).json({ error: "could not fetch run" });
  }
  if (!run) return res.status(404).json({ error: "run not found" });

  const after = Number(req.query.after) || 0;
  const { data: events, error: eventsError } = await db
    .from("claude_run_events")
    .select("seq, kind, text, tool_name, created_at")
    .eq("run_id", run.id)
    .gt("seq", after)
    .order("seq", { ascending: true })
    .limit(EVENT_PAGE);

  if (eventsError) {
    console.error("[claude/runs] events fetch failed:", eventsError.message);
    return res.status(500).json({ error: "could not fetch run events" });
  }

  return res.json({ run, events: events ?? [] });
});

export default router;
