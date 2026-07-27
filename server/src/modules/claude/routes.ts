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

/** The CLI's closed set for --effort. Anything else is rejected rather than passed
 *  through, so a bad value fails here instead of inside the run. */
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Model is validated only for shape, not against a list: aliases (opus, sonnet,
 *  fable) and full ids change over time, and a hardcoded allowlist here would
 *  reject a model that the CLI supports perfectly well. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

  // Both are optional: empty means "use the CLI default", which keeps a run
  // tracking Anthropic's current default model rather than a pinned one.
  const model = str(body.model, 64);
  if (model && !MODEL_RE.test(model)) {
    return res.status(400).json({ error: "invalid model" });
  }
  const effort = str(body.effort, 16);
  if (effort && !EFFORTS.has(effort)) {
    return res.status(400).json({ error: `effort must be one of ${[...EFFORTS].join(", ")}` });
  }

  const { data, error } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      claude_account: str(body.claude_account, 320) || null,
      title,
      prompt,
      model: model || null,
      effort: effort || null,
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
    // Kept as a single string literal: supabase-js infers the row shape by parsing
    // this at the type level, and a concatenated string degrades it to an error type.
    .select("id, title, status, claude_account, repo, session_id, result_summary, error, model, effort, total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, duration_ms, started_at, ended_at, created_at")
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[claude/runs] list failed:", error.message);
    return res.status(500).json({ error: "could not list runs" });
  }
  return res.json({ runs: data ?? [] });
});

/**
 * GET /api/claude/usage — what we actually know about consumption.
 *
 * Built entirely from figures the engine reported on our own runs. It deliberately
 * does NOT claim to show remaining quota: on a Team subscription there is no
 * programmatic source for that (the Analytics API is Enterprise-only), and the
 * per-token cost is not an amount owed — see docs/claude-console/feasibility.md.
 * The response says as much in `disclaimer` so a caller cannot mistake it.
 */
router.get("/claude/usage", async (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await db
    .from("claude_runs")
    .select("status, model, total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, duration_ms, model_usage, created_at")
    .eq("org_id", req.org!.id)
    .gte("created_at", since);

  if (error) {
    console.error("[claude/usage] query failed:", error.message);
    return res.status(500).json({ error: "could not load usage" });
  }

  const rows = data ?? [];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // Per-model totals come from model_usage, the only field that accounts for every
  // model a run touched (the run's own `model` column is just what was requested,
  // and is null whenever the default was used).
  const byModel = new Map<string, { cost: number; input: number; output: number; runs: number }>();
  for (const r of rows) {
    const mu = (r.model_usage ?? null) as Record<string, Record<string, unknown>> | null;
    if (!mu) continue;
    for (const [name, m] of Object.entries(mu)) {
      const cur = byModel.get(name) ?? { cost: 0, input: 0, output: 0, runs: 0 };
      cur.cost += n(m?.costUSD);
      cur.input += n(m?.inputTokens);
      cur.output += n(m?.outputTokens);
      cur.runs += 1;
      byModel.set(name, cur);
    }
  }

  return res.json({
    window_days: days,
    totals: {
      runs: rows.length,
      done: rows.filter((r) => r.status === "done").length,
      failed: rows.filter((r) => r.status === "failed").length,
      cost_usd_equivalent: rows.reduce((s, r) => s + n(r.total_cost_usd), 0),
      input_tokens: rows.reduce((s, r) => s + n(r.input_tokens), 0),
      output_tokens: rows.reduce((s, r) => s + n(r.output_tokens), 0),
      cache_read_tokens: rows.reduce((s, r) => s + n(r.cache_read_tokens), 0),
      cache_creation_tokens: rows.reduce((s, r) => s + n(r.cache_creation_tokens), 0),
      turns: rows.reduce((s, r) => s + n(r.num_turns), 0),
      duration_ms: rows.reduce((s, r) => s + n(r.duration_ms), 0),
    },
    by_model: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.cost - a.cost),
    disclaimer: {
      billing:
        "Runs execute on the Claude subscription and are not billed per token. The " +
        "cost figure is the engine's equivalent-API estimate, used here as a " +
        "consumption measure only.",
      remaining:
        "Remaining subscription quota and reset time are not exposed programmatically " +
        "on a Team plan. See the plan usage screens at claude.ai for those.",
      scope: "Covers only runs launched from this console, not other Claude usage.",
    },
  });
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
