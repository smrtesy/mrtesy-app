/**
 * Claude runs — the app's own API for launching and reading Claude runs.
 *
 * Standard chain: requireAuth → requireOrg → requireSuperAdmin. This is an
 * operator console, not a per-app feature, so it follows the admin-route
 * exception to requireApp("<slug>") rather than inventing an app slug for it.
 * The screen moved out of /admin (docs/claude-console/app-integration-plan.md)
 * but the gate deliberately did NOT move with it: a run executes shell commands
 * on our host with our GitHub token, which is not something to widen to every
 * org member as a side effect of relocating a screen.
 *
 *   POST /api/claude/runs        launch a run (returns immediately; executes async)
 *   GET  /api/claude/runs        list this org's runs
 *   GET  /api/claude/runs/:id    one run + its full event stream
 *   GET  /api/claude/github      is a GitHub token configured
 *   GET  /api/claude/github/repos  every repo that token can reach
 *   POST /api/claude/transcribe  dictation → text (Gemini; see the cost note)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";
import { executeRun, describeAccounts } from "./runner";
import { composePrompt } from "./playbooks";
import { getGitHubToken, listRepos, isValidRepo, isValidBranch, redact } from "./github";
import { deployStatus } from "./deploy-status";
import { transcribeAudio } from "../../gemini";

// The auth chain (requireAuth → requireOrg → requireSuperAdmin) is installed once
// in index.ts for the whole module, so it is NOT repeated here.
const router = Router();

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

  // Validated here rather than in the runner: a bad repo/branch should fail the
  // request the user is watching, not a background run they have to go read.
  const repo = str(body.repo, 200);
  if (repo && !isValidRepo(repo)) {
    return res.status(400).json({ error: "repo must be owner/name" });
  }
  const gitBranch = str(body.git_branch, 200);
  if (gitBranch && !isValidBranch(gitBranch)) {
    return res.status(400).json({ error: "invalid branch name" });
  }
  if (gitBranch && !repo) {
    return res.status(400).json({ error: "a branch needs a repo" });
  }

  const playbookId = str(body.playbook_id, 64) || null;
  if (playbookId && !UUID_RE.test(playbookId)) {
    return res.status(400).json({ error: "invalid playbook_id" });
  }

  // The standing instructions and the chosen method are prepended on the server so
  // a caller cannot skip them. `prompt` stores what was really sent; `user_prompt`
  // keeps what the human typed, which the composed text would otherwise bury.
  const composed = await composePrompt(orgId, prompt, playbookId);
  if (playbookId && !composed.playbook) {
    return res.status(404).json({ error: "playbook not found" });
  }

  const { data, error } = await db
    .from("claude_runs")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      claude_account: str(body.claude_account, 320) || null,
      title,
      prompt: composed.prompt,
      user_prompt: prompt,
      playbook_id: playbookId,
      model: model || null,
      effort: effort || null,
      repo: repo || null,
      git_branch: gitBranch || null,
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

/**
 * GET /api/claude/accounts — the Claude subscription accounts the console can run on.
 *
 * Feeds the header account switcher: which accounts exist, whether each is
 * configured, and any operator-set label. No token value ever leaves the server.
 */
router.get("/claude/accounts", async (_req: Request, res: Response) => {
  try {
    const accounts = await describeAccounts();
    return res.json({ accounts });
  } catch (e) {
    console.error("[claude/accounts] failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "could not load accounts" });
  }
});

router.get("/claude/runs", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);

  const { data, error } = await db
    .from("claude_runs")
    // Kept as a single string literal: supabase-js infers the row shape by parsing
    // this at the type level, and a concatenated string degrades it to an error type.
    .select("id, title, status, claude_account, repo, git_branch, playbook_id, user_prompt, session_id, result_summary, error, model, effort, total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, duration_ms, started_at, ended_at, created_at")
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

// ── GitHub ────────────────────────────────────────────────────────────────────

/**
 * Whether a repo can be picked at all. Answers a boolean and the exact place to
 * put the token — never the token itself, and never a partial/masked copy of it
 * (a prefix is still a leak).
 */
router.get("/claude/github", async (_req: Request, res: Response) => {
  const token = await getGitHubToken();
  return res.json({
    connected: !!token,
    secret_key: "GITHUB_TOKEN",
    secret_location: "/admin/apps/smrttask/secrets",
  });
});

router.get("/claude/github/repos", async (_req: Request, res: Response) => {
  const token = await getGitHubToken();
  if (!token) {
    return res.status(400).json({
      error:
        "GITHUB_TOKEN is not configured. Save a GitHub personal access token with " +
        "'repo' scope under /admin/apps/smrttask/secrets (key: GITHUB_TOKEN).",
    });
  }
  try {
    return res.json({ repos: await listRepos(token) });
  } catch (e) {
    // redact: a GitHub error body can echo the request, token included.
    const msg = redact(e instanceof Error ? e.message : String(e), token);
    console.error("[claude/github] repos failed:", msg);
    return res.status(502).json({ error: msg });
  }
});

// ── Deploy status ───────────────────────────────────────────────────────────────

/**
 * GET /api/claude/deploy-status?sha=<sha> — Vercel (frontend) + Railway (backend)
 * production deploy state, via their official APIs (deploy-status.ts).
 *
 * Richer than /api/deploy-info (which reports only the live frontend commit): this
 * reports in-flight build state (building / ready / error) for BOTH surfaces, so the
 * operator can see a build in progress or a failed build after a merge. Each provider
 * answers `configured:false` with a hint naming the exact secret to set when its token
 * isn't present — never an error.
 */
router.get("/claude/deploy-status", async (req: Request, res: Response) => {
  const sha = typeof req.query.sha === "string" ? req.query.sha.trim().slice(0, 100) : undefined;
  try {
    return res.json(await deployStatus(sha || undefined));
  } catch (e) {
    console.error("[claude/deploy-status] failed:", e instanceof Error ? e.message : e);
    return res.status(500).json({ error: "could not fetch deploy status" });
  }
});

// ── Dictation ─────────────────────────────────────────────────────────────────

/**
 * POST /api/claude/transcribe — { audio_base64, mime_type } → { text }
 *
 * Same Hebrew-aware Gemini transcription the WhatsApp composer uses, so dictation
 * behaves identically in both places instead of being a second implementation.
 *
 * ⚠️ COST: this is a paid Gemini call per dictation (CLAUDE.md cost-approval rule).
 * It is user-initiated — one call per press of the mic — and the screen states as
 * much next to the button. Nothing here loops or batches.
 */
const MAX_AUDIO_BASE64 = 12_000_000; // ~9MB of audio: minutes of speech, not hours.

router.post("/claude/transcribe", async (req: Request, res: Response) => {
  const { audio_base64, mime_type } = (req.body ?? {}) as {
    audio_base64?: string;
    mime_type?: string;
  };
  if (!audio_base64 || typeof audio_base64 !== "string") {
    return res.status(400).json({ error: "audio_base64 is required" });
  }
  if (audio_base64.length > MAX_AUDIO_BASE64) {
    return res.status(413).json({ error: "recording is too long" });
  }
  const cleaned = audio_base64.replace(/^data:[^;]+;base64,/, "");
  try {
    const text = await transcribeAudio(cleaned, mime_type || "audio/webm");
    return res.json({ text });
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
