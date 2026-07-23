/**
 * Experiment scoring — the video-lab blind-scoring pipeline (mini-doc פ-0).
 *
 * Two routers:
 *   1. machineRouter — x-cron-secret gated, NO JWT. The video-lab harness
 *      (Claude / service-role) WRITES runs, opens an approval task for the
 *      manager, and files status reports. Same machine-to-machine pattern as
 *      session-report.ts (resolve user → primary org via org_members).
 *   2. experimentsAuthedRouter — mounted INSIDE the authed smrtplan router
 *      (routes.ts already applies requireAuth + requireOrg + requireApp), so it
 *      inherits `req.org!.id` / `req.user!.id`. The app READS runs (BLIND — the
 *      model/method/prompt/seed are hidden until the caller LOCKS a score) and
 *      SCORES them.
 *
 * Blind rule: a run's model/method/prompt/seed are only returned to a caller
 * who has at least one LOCKED score for that test_label. Until then those
 * fields come back null so scoring stays model-agnostic.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../db";

type Row = Record<string, unknown>;
function asRows(d: unknown): Row[] {
  return (Array.isArray(d) ? d : []) as Row[];
}

const MAX_FIELD = 8000;
function clean(v: unknown, max = MAX_FIELD): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Resolve a user by explicit id or by email — identical logic to
 *  session-report.ts's resolveUserId (this codebase has no shared-utils layer
 *  for this small helper, so it is duplicated here). */
async function resolveUserId(userId?: string, email?: string): Promise<string | null> {
  if (userId && typeof userId === "string" && userId.trim()) return userId.trim();
  if (!email) return null;
  const target = email.trim().toLowerCase();
  const { data, error } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    console.error("[experiments] listUsers failed:", error.message);
    return null;
  }
  const hit = (data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === target);
  return hit?.id ?? null;
}

/** Resolve a user's primary org (earliest membership), like session-report.ts. */
async function resolvePrimaryOrg(userId: string): Promise<string | null> {
  const { data, error } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[experiments] org resolve failed:", error.message);
    return null;
  }
  return (data?.org_id as string | undefined) ?? null;
}

// ── machine router (x-cron-secret gated, no JWT) ──────────────────────────────

export const machineRouter = Router();

/** Guard: require the shared machine secret to be SET and matched. Returns true
 *  when the request is authorised; otherwise writes a 401 and returns false. */
function machineAuthed(req: Request, res: Response): boolean {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

/**
 * POST /experiments/runs — the harness inserts a run row. Resolves org from
 * user_id/user_email via org_members. The blind `code` is required; everything
 * else is optional metadata.
 */
machineRouter.post("/experiments/runs", async (req: Request, res: Response) => {
  if (!machineAuthed(req, res)) return;
  const body = req.body ?? {};

  const code = clean(body.code, 200);
  if (!code) return res.status(400).json({ error: "code is required" });

  const userId = await resolveUserId(
    typeof body.user_id === "string" ? body.user_id : undefined,
    typeof body.user_email === "string" ? body.user_email : undefined,
  );
  if (!userId) return res.status(404).json({ error: "user not found" });
  const orgId = await resolvePrimaryOrg(userId);
  if (!orgId) return res.status(403).json({ error: "user has no org" });

  const numOrNull = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const intOrNull = (v: unknown): number | null => {
    const n = numOrNull(v);
    return n == null ? null : Math.trunc(n);
  };

  // QC (auto-QC) fields. qc_status validated to the allowed enum; anything else
  // (or absent) falls back to 'pending'. qc_scores is a per-metric numeric map.
  const QC_STATUSES = ["pending", "pass", "rejected"] as const;
  const rawQcStatus = clean(body.qc_status, 20);
  const qcStatus = (QC_STATUSES as readonly string[]).includes(rawQcStatus)
    ? rawQcStatus
    : "pending";
  const qcScores =
    body.qc_scores && typeof body.qc_scores === "object" && !Array.isArray(body.qc_scores)
      ? (body.qc_scores as Record<string, unknown>)
      : {};

  const insert: Row = {
    org_id: orgId,
    plan_id: typeof body.plan_id === "string" && body.plan_id.trim() ? body.plan_id.trim() : null,
    task_id: typeof body.task_id === "string" && body.task_id.trim() ? body.task_id.trim() : null,
    stage: clean(body.stage, 100) || null,
    test_label: clean(body.test_label, 200) || null,
    code,
    model: clean(body.model, 200) || null,
    method: clean(body.method, 500) || null,
    prompt: clean(body.prompt) || null,
    seed: intOrNull(body.seed),
    cost_usd: numOrNull(body.cost_usd),
    output_url: clean(body.output_url, 2000) || null,
    scene: clean(body.scene, 500) || null,
    variation: intOrNull(body.variation),
    repeat_idx: intOrNull(body.repeat_idx),
    meta: body.meta && typeof body.meta === "object" ? body.meta : {},
    qc_status: qcStatus,
    qc_score: numOrNull(body.qc_score),
    qc_reason: clean(body.qc_reason) || null,
    qc_scores: qcScores,
    created_by: userId,
  };

  const { data, error } = await db.from("experiment_runs").insert(insert).select("id").single();
  if (error || !data) return res.status(500).json({ error: error?.message ?? "insert failed" });
  res.json({ ok: true, id: data.id });
});

/**
 * POST /experiments/approval-task — the inter-personal handoff. Opens an
 * approval task in the manager's smrtPlan inbox. The manager is the plan's owner
 * (smrtplan_plans.created_by) when a plan_id is given, else the resolved user.
 */
machineRouter.post("/experiments/approval-task", async (req: Request, res: Response) => {
  if (!machineAuthed(req, res)) return;
  const body = req.body ?? {};

  const title = clean(body.title, 500);
  if (!title) return res.status(400).json({ error: "title is required" });

  const userId = await resolveUserId(
    typeof body.user_id === "string" ? body.user_id : undefined,
    typeof body.user_email === "string" ? body.user_email : undefined,
  );
  if (!userId) return res.status(404).json({ error: "user not found" });
  const orgId = await resolvePrimaryOrg(userId);
  if (!orgId) return res.status(403).json({ error: "user has no org" });

  const planId = typeof body.plan_id === "string" && body.plan_id.trim() ? body.plan_id.trim() : null;
  // Route the approval to the plan's owner when we have a plan, else the caller.
  let managerUserId = userId;
  if (planId) {
    const { data: plan } = await db
      .from("smrtplan_plans")
      .select("created_by, owner_user_id")
      .eq("org_id", orgId)
      .eq("id", planId)
      .maybeSingle();
    const owner = (plan?.created_by as string | null) ?? (plan?.owner_user_id as string | null);
    if (owner) managerUserId = owner;
  }

  const url = clean(body.url, 2000);
  const actionLinks = url ? [{ label: "פתח לצפייה ואישור", url }] : [];

  const { data, error } = await db
    .from("tasks")
    .insert({
      organization_id: orgId,
      user_id: managerUserId,
      title,
      title_he: title,
      description: clean(body.description) || null,
      status: "inbox",
      task_type: "followup",
      priority: "medium",
      manually_verified: false,
      action_links: actionLinks,
      plan_id: planId,
      tags: ["video-lab", "approval"],
    })
    .select("id")
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message ?? "insert failed" });
  res.json({ ok: true, id: data.id });
});

/**
 * POST /experiments/report — files a lightweight status report as a task in the
 * manager's inbox (task_type followup, tags video-lab/report).
 */
machineRouter.post("/experiments/report", async (req: Request, res: Response) => {
  if (!machineAuthed(req, res)) return;
  const body = req.body ?? {};

  const summary = clean(body.summary);
  if (!summary) return res.status(400).json({ error: "summary is required" });

  const userId = await resolveUserId(
    typeof body.user_id === "string" ? body.user_id : undefined,
    typeof body.user_email === "string" ? body.user_email : undefined,
  );
  if (!userId) return res.status(404).json({ error: "user not found" });
  const orgId = await resolvePrimaryOrg(userId);
  if (!orgId) return res.status(403).json({ error: "user has no org" });

  const planId = typeof body.plan_id === "string" && body.plan_id.trim() ? body.plan_id.trim() : null;
  let managerUserId = userId;
  if (planId) {
    const { data: plan } = await db
      .from("smrtplan_plans")
      .select("created_by, owner_user_id")
      .eq("org_id", orgId)
      .eq("id", planId)
      .maybeSingle();
    const owner = (plan?.created_by as string | null) ?? (plan?.owner_user_id as string | null);
    if (owner) managerUserId = owner;
  }

  const status = clean(body.status, 100);
  const title = `דוח מעבדת וידאו${status ? ` — ${status}` : ""}`;

  const { data, error } = await db
    .from("tasks")
    .insert({
      organization_id: orgId,
      user_id: managerUserId,
      title,
      title_he: title,
      description: summary,
      status: "inbox",
      task_type: "followup",
      priority: "low",
      manually_verified: false,
      plan_id: planId,
      tags: ["video-lab", "report"],
    })
    .select("id")
    .single();
  if (error || !data) return res.status(500).json({ error: error?.message ?? "insert failed" });
  res.json({ ok: true, id: data.id });
});

// ── authed router (mounted inside the authed smrtplan chain) ──────────────────

export const experimentsAuthedRouter = Router();

/** The run fields hidden until the caller has locked a score. NOTE: `prompt` is
 *  intentionally NOT blind — the user wants full prompt transparency at all
 *  times; only model/method/seed stay hidden until reveal. */
const BLIND_FIELDS = ["model", "method", "seed"] as const;

/**
 * GET /experiments/runs?plan_id=&test_label= — runs for the caller's org, plan,
 * and test. BLIND: model/method/prompt/seed are nulled out unless the caller has
 * at least one LOCKED score for that test_label. Each run carries the caller's
 * own scores. Ordered by code.
 */
experimentsAuthedRouter.get("/experiments/runs", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const userId = req.user!.id;
  const planId = typeof req.query.plan_id === "string" ? req.query.plan_id : null;
  const testLabel = typeof req.query.test_label === "string" ? req.query.test_label : null;
  // Optional QC filter: pending|pass|rejected. Anything else (incl. 'all') = no filter.
  const qcFilterRaw = typeof req.query.qc_status === "string" ? req.query.qc_status : "all";
  const qcFilter = ["pending", "pass", "rejected"].includes(qcFilterRaw) ? qcFilterRaw : null;

  let q = db.from("experiment_runs").select("*").eq("org_id", orgId);
  if (planId) q = q.eq("plan_id", planId);
  if (testLabel) q = q.eq("test_label", testLabel);
  if (qcFilter) q = q.eq("qc_status", qcFilter);
  const { data: runsRaw, error } = await q.order("code", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const runs = asRows(runsRaw);
  const runIds = runs.map((r) => r.id as string);

  // The caller's own scores across these runs.
  let myScores: Row[] = [];
  if (runIds.length) {
    const { data: sc } = await db
      .from("experiment_scores")
      .select("run_id, dimension, score, locked")
      .eq("org_id", orgId)
      .eq("scorer_id", userId)
      .in("run_id", runIds);
    myScores = asRows(sc);
  }
  // Revealed = the caller has at least one LOCKED score across this set.
  const revealed = myScores.some((s) => s.locked === true);

  const scoresByRun = new Map<string, Row[]>();
  for (const s of myScores) {
    const rid = s.run_id as string;
    const arr = scoresByRun.get(rid) ?? [];
    arr.push({ dimension: s.dimension, score: s.score, locked: s.locked });
    scoresByRun.set(rid, arr);
  }

  const out = runs.map((r) => {
    const run: Row = { ...r, my_scores: scoresByRun.get(r.id as string) ?? [] };
    if (!revealed) for (const f of BLIND_FIELDS) run[f] = null;
    return run;
  });

  res.json({ runs: out, revealed });
});

/**
 * POST /experiments/scores — upsert the caller's score for a run+dimension.
 * body { run_id, dimension?, score (1-5) }.
 */
experimentsAuthedRouter.post("/experiments/scores", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const userId = req.user!.id;
  const body = req.body ?? {};

  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  if (!runId) return res.status(400).json({ error: "run_id is required" });
  const dimension = clean(body.dimension, 50) || "overall";
  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ error: "score must be an integer 1-5" });
  }

  // The run must belong to the caller's org.
  const { data: run, error: runErr } = await db
    .from("experiment_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", runId)
    .maybeSingle();
  if (runErr) return res.status(500).json({ error: runErr.message });
  if (!run) return res.status(404).json({ error: "run not found" });

  const { error } = await db.from("experiment_scores").upsert(
    {
      org_id: orgId,
      run_id: runId,
      scorer_id: userId,
      dimension,
      score,
    },
    { onConflict: "run_id,scorer_id,dimension" },
  );
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/**
 * POST /experiments/override — a human rescues (or un-rescues) a run the auto-QC
 * flagged. body { run_id, overridden (bool) }. When overridden=true the run is
 * treated as manually kept despite a 'rejected' qc_status. Org-scoped.
 */
experimentsAuthedRouter.post("/experiments/override", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const body = req.body ?? {};

  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  if (!runId) return res.status(400).json({ error: "run_id is required" });
  const overridden = body.overridden === true;

  // The run must belong to the caller's org.
  const { data: run, error: runErr } = await db
    .from("experiment_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("id", runId)
    .maybeSingle();
  if (runErr) return res.status(500).json({ error: runErr.message });
  if (!run) return res.status(404).json({ error: "run not found" });

  const { error } = await db
    .from("experiment_runs")
    .update({ overridden })
    .eq("org_id", orgId)
    .eq("id", runId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/**
 * POST /experiments/reveal — lock all of the caller's scores for runs in the
 * given org+test_label, which flips the blind reveal on for the caller.
 * body { plan_id?, test_label }.
 */
experimentsAuthedRouter.post("/experiments/reveal", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const userId = req.user!.id;
  const body = req.body ?? {};

  const testLabel = clean(body.test_label, 200);
  if (!testLabel) return res.status(400).json({ error: "test_label is required" });
  const planId = typeof body.plan_id === "string" && body.plan_id.trim() ? body.plan_id.trim() : null;

  let q = db.from("experiment_runs").select("id").eq("org_id", orgId).eq("test_label", testLabel);
  if (planId) q = q.eq("plan_id", planId);
  const { data: runsRaw, error: runErr } = await q;
  if (runErr) return res.status(500).json({ error: runErr.message });
  const runIds = asRows(runsRaw).map((r) => r.id as string);
  if (runIds.length === 0) return res.json({ ok: true, revealed: true });

  const { error } = await db
    .from("experiment_scores")
    .update({ locked: true })
    .eq("org_id", orgId)
    .eq("scorer_id", userId)
    .in("run_id", runIds);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, revealed: true });
});

/**
 * GET /experiments/summary?plan_id=&test_label= — per-run aggregate: average
 * score across ALL scorers per dimension + count. The model is only included
 * when the caller has unlocked the reveal (same blind rule as /runs).
 */
experimentsAuthedRouter.get("/experiments/summary", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const userId = req.user!.id;
  const planId = typeof req.query.plan_id === "string" ? req.query.plan_id : null;
  const testLabel = typeof req.query.test_label === "string" ? req.query.test_label : null;

  let q = db.from("experiment_runs").select("id, code, model").eq("org_id", orgId);
  if (planId) q = q.eq("plan_id", planId);
  if (testLabel) q = q.eq("test_label", testLabel);
  const { data: runsRaw, error } = await q.order("code", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  const runs = asRows(runsRaw);
  const runIds = runs.map((r) => r.id as string);

  // Whether the caller may see model names (has ≥1 locked score in this set).
  let revealed = false;
  const dimAgg = new Map<string, Map<string, { sum: number; count: number }>>();
  if (runIds.length) {
    const { data: scoresRaw } = await db
      .from("experiment_scores")
      .select("run_id, dimension, score, locked, scorer_id")
      .eq("org_id", orgId)
      .in("run_id", runIds);
    for (const s of asRows(scoresRaw)) {
      if (s.locked === true && s.scorer_id === userId) revealed = true;
      const rid = s.run_id as string;
      const dim = (s.dimension as string) || "overall";
      const byDim = dimAgg.get(rid) ?? new Map();
      const cur = byDim.get(dim) ?? { sum: 0, count: 0 };
      cur.sum += Number(s.score) || 0;
      cur.count += 1;
      byDim.set(dim, cur);
      dimAgg.set(rid, byDim);
    }
  }

  const rows = runs.map((r) => {
    const rid = r.id as string;
    const byDim = dimAgg.get(rid) ?? new Map<string, { sum: number; count: number }>();
    const averages: Record<string, { avg: number; count: number }> = {};
    for (const [dim, { sum, count }] of byDim.entries()) {
      averages[dim] = { avg: count ? Math.round((sum / count) * 100) / 100 : 0, count };
    }
    return {
      run_id: rid,
      code: r.code,
      model: revealed ? r.model : null,
      averages,
    };
  });

  res.json({ rows, revealed });
});

export default experimentsAuthedRouter;
