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
import {
  executeRun,
  describeAccounts,
  isRunLive,
  runEventBus,
  mostRecentWeeklyReset,
  type LiveEvent,
} from "./runner";
import { composePrompt } from "./playbooks";
import { getGitHubToken, listRepos, isValidRepo, isValidBranch, redact } from "./github";
import { deployStatus } from "./deploy-status";
import { analyzeRun, normalizeDbEvent, type EfficiencyFlag } from "./efficiency";
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
  // ?order=ended sorts by completion time (newest finished first) — what the
  // tasks-desk activity bar needs: a long run CREATED hours ago that finishes
  // NOW must surface at the top, which created_at ordering would bury.
  const orderCol = req.query.order === "ended" ? "ended_at" : "created_at";

  const { data, error } = await db
    .from("claude_runs")
    // Kept as a single string literal: supabase-js infers the row shape by parsing
    // this at the type level, and a concatenated string degrades it to an error type.
    // thread_id rides along so the tasks-screen activity bar can deep-link each
    // finished run to its conversation (/claude?thread=<id>).
    .select("id, thread_id, title, status, claude_account, repo, git_branch, playbook_id, user_prompt, session_id, result_summary, error, model, effort, total_cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns, duration_ms, started_at, ended_at, created_at")
    .eq("org_id", req.org!.id)
    // nullsFirst:false so still-running rows (ended_at null) sink to the tail
    // under ?order=ended instead of crowding out the finished ones.
    .order(orderCol, { ascending: false, nullsFirst: false })
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

/**
 * GET /claude/account-usage?account=<acct> — the live limit ESTIMATE for one
 * Claude account, for the composer's usage meter (the filling-circle icon).
 *
 * Reads the SAME estimator the alert cron uses (check_claude_usage_limits, called
 * dry-run so no notifications fire) for the rolling 5-hour window, plus a rolling
 * 7-day total for the weekly figure. This is an ESTIMATE from our own runs vs a
 * calibrated cap — NOT Anthropic's real remaining quota, which is not exposed on
 * a Team plan (see the /claude/usage disclaimer). Weekly has no calibration event
 * yet, so it is display-only.
 */
router.get("/claude/account-usage", async (req: Request, res: Response) => {
  const account =
    typeof req.query.account === "string" && req.query.account.trim()
      ? req.query.account.trim()
      : null;
  if (!account) return res.status(400).json({ error: "account required" });

  // 5-hour window from the shared estimator. p_dry_run=true → read-only, never
  // files an alert (that is the cron's job, not a screen read's).
  const { data: sessRows, error: sErr } = await db.rpc("check_claude_usage_limits", {
    p_dry_run: true,
  });
  if (sErr) {
    console.error("[claude/account-usage] estimator failed:", sErr.message);
    return res.status(500).json({ error: "usage unavailable" });
  }
  const s =
    (sessRows as { claude_account: string; window_end: string; cost_used: number; cap_cost: number; pct: number }[] | null)?.find(
      (r) => r.claude_account === account,
    ) ?? null;

  // Weekly window: from THIS account's last reset if the operator set a schedule
  // (Anthropic resets each account on its own day/time — configured in the Claude
  // accounts admin), else a rolling 7 days. Matching Claude's fixed reset is what
  // keeps the weekly percent tracking Claude's own counter through the week and
  // dropping to ~0 right after its reset, instead of a rolling sum that always
  // carries the prior week.
  const acctInfo = (await describeAccounts()).find((a) => a.id === account) ?? null;
  const weekStartMs = acctInfo?.weeklyReset
    ? mostRecentWeeklyReset(acctInfo.weeklyReset, Date.now())
    : Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekSince = new Date(weekStartMs).toISOString();
  const { data: wkRows, error: wkErr } = await db
    .from("claude_runs")
    .select("total_cost_usd")
    .eq("claude_account", account)
    .gte("created_at", weekSince);
  if (wkErr) console.error("[claude/account-usage] weekly cost read failed:", wkErr.message);
  const weekCost = (wkRows ?? []).reduce(
    (a, r) => a + (Number(r.total_cost_usd) || 0),
    0,
  );
  const { data: capRows, error: capErr } = await db
    .from("claude_usage_limits")
    .select("claude_account, cap_cost_usd, note")
    .in("claude_account", [account, "*"])
    .eq("window_kind", "weekly");
  if (capErr) console.error("[claude/account-usage] weekly cap read failed:", capErr.message);
  const capRow =
    capRows?.find((c) => c.claude_account === account) ??
    capRows?.find((c) => c.claude_account === "*") ??
    null;
  const weekCap = Number(capRow?.cap_cost_usd ?? 0);

  // A weekly PERCENT is only honest once the cap is calibrated: EITHER a real
  // weekly limit-hit set it, OR it was hand-anchored to a real reading from
  // Claude's own usage tool (the operator writes that cap with a note prefixed
  // "manual calib"). The bare seeded '*' placeholder ($200) has neither, so its
  // percent stays hidden (pct:null → the meter shows "not calibrated yet") while
  // still displaying the cost. The window above is aligned to THIS account's
  // configured reset (so the percent tracks Claude's counter and drops to ~0
  // right after its reset); with no schedule set it falls back to a rolling 7
  // days, which reads higher than Claude's right after a reset. Either way it is
  // an estimate, per the disclaimer, not a mirror of Claude's counter.
  const { count: weeklyHits, error: whErr } = await db
    .from("claude_usage_hits")
    .select("id", { count: "exact", head: true })
    .eq("kind", "weekly");
  if (whErr) console.error("[claude/account-usage] weekly-hits read failed:", whErr.message);
  const manualWeekly = /^manual calib/i.test(String(capRow?.note ?? ""));
  const weeklyCalibrated = weekCap > 0 && ((weeklyHits ?? 0) > 0 || manualWeekly);

  // Anthropic's OWN ground truth for this account's windows, captured live from the
  // CLI's rate_limit_event (runner.ts → claude_usage_windows). A window row still
  // "live" (its reset instant is in the FUTURE, i.e. the window it describes hasn't
  // closed) OVERRIDES the reconstructed estimate: the reset time is exact, and the
  // percent is exact whenever the CLI reported utilization (it does so only past its
  // warning threshold, ~>75% — below that, utilization is absent and we keep the
  // cost estimate for the percent while still using the exact reset time). Once
  // resets_at is in the past the row describes a window that already reset, so it is
  // stale → fall back to the estimator until the next run refreshes it.
  const { data: winRows, error: winErr } = await db
    .from("claude_usage_windows")
    .select("window_kind, resets_at, utilization, status")
    .eq("claude_account", account);
  if (winErr) console.error("[claude/account-usage] usage-windows read failed:", winErr.message);
  const nowMs = Date.now();
  const liveWindow = (kind: "five_hour" | "seven_day") => {
    const w = (winRows ?? []).find((r) => r.window_kind === kind);
    if (!w?.resets_at || new Date(w.resets_at).getTime() <= nowMs) return null;
    return w;
  };
  const utilPct = (w: { utilization: number | null }) =>
    w.utilization != null ? Math.round(Number(w.utilization) * 100) : null;

  // Session (5-hour): live window wins; else the reconstructed estimate; else null.
  const liveSession = liveWindow("five_hour");
  let sessionOut: {
    pct: number;
    pct_raw: number;
    cost_used: number;
    cap: number;
    window_end: string;
    source: "anthropic" | "estimate";
    pct_source: "anthropic" | "estimate";
  } | null = null;
  if (liveSession) {
    const real = utilPct(liveSession);
    const pct = real ?? (s ? s.pct : 0);
    sessionOut = {
      pct: Math.min(100, pct),
      pct_raw: pct,
      cost_used: s ? Number(s.cost_used) : 0,
      cap: s ? Number(s.cap_cost) : 0,
      window_end: liveSession.resets_at,
      source: "anthropic",
      pct_source: real != null ? "anthropic" : "estimate",
    };
  } else if (s) {
    sessionOut = {
      pct: Math.min(100, s.pct),
      pct_raw: s.pct,
      cost_used: Number(s.cost_used),
      cap: Number(s.cap_cost),
      window_end: s.window_end,
      source: "estimate",
      pct_source: "estimate",
    };
  }

  // Weekly (7-day): live window wins for reset time (always) and percent (when the
  // CLI gave utilization); else fall back to the calibrated-cost estimate over the
  // schedule-aligned window; else display-only.
  const liveWeekly = liveWindow("seven_day");
  const estWeeklyEnd = acctInfo?.weeklyReset
    ? new Date(
        mostRecentWeeklyReset(
          acctInfo.weeklyReset,
          weekStartMs + 7 * 24 * 60 * 60 * 1000 + 60_000,
        ),
      ).toISOString()
    : null;
  const estWeeklyPct = weeklyCalibrated
    ? Math.min(100, Math.floor((weekCost / weekCap) * 100))
    : null;
  const weeklyReal = liveWeekly ? utilPct(liveWeekly) : null;
  const weeklyOut = {
    pct: weeklyReal ?? estWeeklyPct,
    cost_used: Math.round(weekCost * 100) / 100,
    cap: weeklyCalibrated ? weekCap : null,
    window_end: liveWeekly ? liveWeekly.resets_at : estWeeklyEnd,
    source: (liveWeekly ? "anthropic" : "estimate") as "anthropic" | "estimate",
    pct_source: (weeklyReal != null ? "anthropic" : "estimate") as "anthropic" | "estimate",
  };

  // The meter is on real Anthropic figures when BOTH windows resolved from a live
  // rate_limit_event — then the reset times are exact (and the percents too, once
  // past the warning threshold). Otherwise it is still partly the cost estimate.
  const live = sessionOut?.source === "anthropic" && weeklyOut.source === "anthropic";

  return res.json({
    account,
    session: sessionOut,
    weekly: weeklyOut,
    live,
    disclaimer: live
      ? "זמן האיפוס מדויק מאנתרופיק; האחוז מדויק כשקרוב למגבלה, אחרת אומדן מהצריכה"
      : "אומדן מהצריכה דרך הכלים שלנו — לא נתון רשמי מאנתרופיק",
  });
});

/**
 * GET /api/claude/efficiency — the "is the console wasting tools/turns" panel.
 *
 * Runs the Level-1 waste detector (efficiency.ts) over the org's most recent
 * runs and returns, per run, its tool counts + waste flags (each citing the
 * `seq` it was found at), plus normalized aggregate RATES — because raw totals
 * are not comparable across runs of different sizes, only rates are. This is
 * pure analysis of events already stored: zero paid tokens, no model call.
 *
 * Deliberately bounded: it analyzes the newest `limit` runs (not the whole
 * history) and caps events per run, so a huge backlog can't make one screen load
 * scan millions of rows. A run whose events hit the cap is marked
 * `events_truncated` rather than silently analyzed half-way.
 */
const EFF_EVENT_CAP = 4000;

router.get("/claude/efficiency", async (req: Request, res: Response) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: runRows, error: runErr } = await db
    .from("claude_runs")
    .select("id, title, status, num_turns, created_at")
    .eq("org_id", req.org!.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (runErr) {
    console.error("[claude/efficiency] runs query failed:", runErr.message);
    return res.status(500).json({ error: "could not load efficiency" });
  }

  const runs = runRows ?? [];
  const disclaimer = {
    scope:
      "Level-1 mechanical waste only: a re-read of an unchanged file, an identical " +
      "repeated search, a retried failing call, and read-only shell issued one call " +
      "at a time. Each flag cites the seq it was found at. It does NOT judge whether " +
      "an approach was smart — that needs a model and a model cannot be the authority " +
      "on it.",
    tokens:
      "A re-read of an unchanged file usually hits the prompt cache, so it costs a " +
      "turn and latency more than tokens. Token cost is per RUN (from claude_runs), " +
      "not attributable to a single tool call.",
    coverage: "Covers only runs launched from this console, newest first.",
  };

  if (runs.length === 0) {
    return res.json({ window_days: days, runs: [], rates: null, disclaimer });
  }

  // One bounded query per run (≤ `limit` runs), in parallel. Per-run keeps the
  // seq ordering coherent for dedup — a single cross-run query with a global cap
  // would truncate whole runs, corrupting the analysis of the ones that survived.
  const analyzed = await Promise.all(
    runs.map(async (run) => {
      const { data: evRows, error: evErr } = await db
        .from("claude_run_events")
        .select("seq, kind, tool_name, text, payload")
        .eq("run_id", run.id)
        .in("kind", ["tool_use", "tool_result"])
        .order("seq", { ascending: true })
        .limit(EFF_EVENT_CAP);
      if (evErr) {
        console.error(`[claude/efficiency] events query failed for ${run.id}:`, evErr.message);
        return null;
      }
      const rows = evRows ?? [];
      const eff = analyzeRun(rows.map(normalizeDbEvent));
      const topTools = Object.entries(eff.toolCounts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
      return {
        id: run.id,
        title: run.title,
        status: run.status,
        created_at: run.created_at,
        num_turns: run.num_turns,
        tool_calls: eff.toolCalls,
        top_tools: topTools,
        flags: eff.flags.slice(0, 30),
        flag_count: eff.flags.length,
        waste_score: eff.wasteScore,
        events_truncated: rows.length >= EFF_EVENT_CAP,
      };
    }),
  );

  const ok = analyzed.filter((r): r is NonNullable<typeof r> => r !== null);
  const runsFailed = analyzed.length - ok.length;
  if (runsFailed > 0 && ok.length === 0) {
    // Every per-run events query errored — this is a failure, not "no waste".
    console.error(`[claude/efficiency] all ${runsFailed} run analyses failed`);
    return res.status(500).json({ error: "could not analyze runs" });
  }

  // Aggregate RATES, not totals: error_retry sums its retry counts, the others
  // count flags, and per-100-calls normalizes so runs of different sizes compare.
  const byCode = { duplicate_read: 0, redundant_search: 0, error_retry: 0, unbatched_reads: 0 };
  let totalToolCalls = 0;
  let totalTurns = 0;
  for (const r of ok) {
    totalToolCalls += r.tool_calls;
    totalTurns += typeof r.num_turns === "number" ? r.num_turns : 0;
    for (const f of r.flags as EfficiencyFlag[]) {
      if (f.code === "error_retry") byCode.error_retry += f.count ?? 1;
      else byCode[f.code] += 1;
    }
  }
  const per100 = (n: number) =>
    totalToolCalls > 0 ? Math.round((n / totalToolCalls) * 1000) / 10 : 0;

  return res.json({
    window_days: days,
    runs: ok.sort((a, b) => b.waste_score - a.waste_score),
    rates: {
      runs_analyzed: ok.length,
      runs_failed: runsFailed,
      total_tool_calls: totalToolCalls,
      total_turns: totalTurns,
      flags_by_code: byCode,
      per_100_calls: {
        duplicate_read: per100(byCode.duplicate_read),
        redundant_search: per100(byCode.redundant_search),
        error_retry: per100(byCode.error_retry),
        unbatched_reads: per100(byCode.unbatched_reads),
      },
      avg_tool_calls: ok.length ? Math.round((totalToolCalls / ok.length) * 10) / 10 : 0,
      avg_turns: ok.length ? Math.round((totalTurns / ok.length) * 10) / 10 : 0,
    },
    disclaimer,
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

/**
 * GET /api/claude/runs/:id/stream — live NDJSON tail of a running turn.
 *
 * Taps the runner's in-process event bus (runner.ts runEventBus), so output
 * reaches the screen the moment the engine emits it — no DB batch (~500ms), no
 * poll (~900ms). One JSON object per line, shaped exactly like the poll's
 * events ({seq, kind, text, tool_name, created_at}), so the client merges both
 * sources by seq. Events are already redacted at emit time.
 *
 * 204 when this process has no live child for the id — a run on another
 * instance, or one that already finished. The client treats that as "no stream,
 * keep polling", which is also the complete story on a horizontally-scaled
 * backend: the stream is an accelerator, the poll is the authority.
 */
router.get("/claude/runs/:id/stream", async (req: Request, res: Response) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: "run not found" });

  // Org scope first — the bus is keyed by run id alone, so the ownership check
  // must happen here, before any event is written.
  const { data: run, error } = await db
    .from("claude_runs")
    .select("id, status")
    .eq("id", req.params.id)
    .eq("org_id", req.org!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: "could not fetch run" });
  if (!run) return res.status(404).json({ error: "run not found" });
  if (!isRunLive(run.id)) return res.status(204).end();

  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  // Railway's proxy buffers by default without this on some paths; harmless elsewhere.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const onEvent = (ev: LiveEvent) => {
    res.write(`${JSON.stringify(ev)}\n`);
  };
  const onEnd = () => cleanup(true);
  // Keep intermediaries from idling the connection out during a long quiet tool
  // call: a bare newline every 15s, which the client's line parser skips.
  const heartbeat = setInterval(() => res.write("\n"), 15_000);

  let done = false;
  const cleanup = (endResponse: boolean) => {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    runEventBus.off(`ev:${run.id}`, onEvent);
    runEventBus.off(`end:${run.id}`, onEnd);
    if (endResponse) res.end();
  };

  runEventBus.on(`ev:${run.id}`, onEvent);
  runEventBus.once(`end:${run.id}`, onEnd);
  // Re-check AFTER subscribing: a run that finished in the gap between the
  // isRunLive gate above and these listeners already fired its `end:` — no one
  // would ever close this response. Now either the listener catches the end or
  // this catches a run that is already gone.
  if (!isRunLive(run.id)) return cleanup(true);
  req.on("close", () => cleanup(false));
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
