/**
 * smrtPlan routes — the planning layer over smrtTask.
 *
 *   GET    /plans                     list plans (org), with effective progress
 *   GET    /plans/board               grouped rows for the Gantt board
 *   GET    /plans/repository          plans with no start_date (the repository)
 *   GET    /plans/access              current user's access level (full/lite)
 *   POST   /plans                     create a plan            (full)
 *   GET    /plans/:id                 single plan
 *   PATCH  /plans/:id                 update a plan            (full)
 *   DELETE /plans/:id                 delete a plan            (full)
 *   GET    /plans/:id/tasks           tasks under an effort plan (+ needs/handoff)
 *   GET    /plans/:id/matrix          stream matrix (stages × episodes)
 *   POST   /plans/:id/stages          add a stage              (full)
 *   POST   /plans/:id/episodes        add an episode           (full)
 *   POST   /plans/:id/recompute       run the engine for this plan (full)
 *   PATCH  /plan-cells/:id            set a matrix cell status (full)
 *   POST   /plan-dependencies         add a dependency edge    (full)
 *   DELETE /plan-dependencies/:id     remove a dependency edge (full)
 *
 * Every query is scoped to the active org. full/lite is enforced per the
 * decisions doc (ג.6): lite = consumer (read), full = creator (write).
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { db } from "../../db";
import { requireAuth, requireOrg, requireApp } from "../../middleware";
import { computeOrgSchedule } from "./engine";

const DONE_STATUSES = new Set(["completed", "archived", "dismissed"]);

/**
 * Per-plan health, duration-weighted (fix #1). A subtask's weight is its
 * duration; "expected" progress accrues that weight once the day it is supposed
 * to finish (latest_finish / due_date) has passed — not a naive linear ramp.
 *   actual ≥ expected         → on track
 *   actual <  expected        → behind  (at_risk)
 *   any open task past its finish → late (a hard miss outranks "behind")
 */
function planHealthFromTasks(
  plan: Row,
  tasksByPlan: Map<string, Row[]>,
  todayISO: string,
): "waiting" | "on_track" | "at_risk" | "late" | "stream" {
  const start = plan.start_date as string | null;
  if (start && todayISO < start) return "waiting";
  if (plan.kind === "stream") return "stream";

  const tasks = tasksByPlan.get(plan.id as string) ?? [];
  if (tasks.length === 0) return "on_track";

  const weight = (t: Row) => Math.max(1, (t.duration_days as number | null) ?? 1);
  const finishOf = (t: Row) => (t.latest_finish as string | null) ?? (t.due_date as string | null);

  let total = 0;
  let done = 0;
  let expected = 0;
  let hardLate = false;
  for (const t of tasks) {
    const w = weight(t);
    total += w;
    const isDone = DONE_STATUSES.has(t.status as string);
    if (isDone) done += w;
    const finish = finishOf(t);
    if (finish && finish <= todayISO) expected += w; // its day to be done has arrived
    if (!isDone && finish && finish < todayISO) hardLate = true;
  }
  if (hardLate) return "late";
  if (total > 0 && done / total + 0.001 < expected / total) return "at_risk"; // behind schedule
  return "on_track";
}

/** Attach duration-weighted health to a list of plans. */
async function withHealth(orgId: string, plans: Row[]): Promise<Row[]> {
  if (plans.length === 0) return plans;
  const { data: taskRows } = await db
    .from("tasks")
    .select("plan_id, status, latest_finish, latest_start, due_date, duration_days")
    .eq("organization_id", orgId)
    .not("plan_id", "is", null);
  const byPlan = new Map<string, Row[]>();
  for (const t of asRows(taskRows)) {
    const pid = t.plan_id as string;
    if (!byPlan.has(pid)) byPlan.set(pid, []);
    byPlan.get(pid)!.push(t);
  }
  const todayISO = new Date().toISOString().slice(0, 10);
  return plans.map((p) => ({ ...p, health: planHealthFromTasks(p, byPlan, todayISO) }));
}

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrtplan"));

/**
 * Supabase-js infers `GenericStringError[]` for selects built from a non-literal
 * string (our reusable PLAN_FIELDS / concatenated column lists). These rows are
 * plain JSON at runtime, so normalise them to a typed record array.
 */
type Row = Record<string, unknown>;
function asRows(d: unknown): Row[] {
  return (Array.isArray(d) ? d : []) as Row[];
}

/**
 * Re-run the scheduling engine after a mutation that changes the graph
 * (dependencies, durations, deadlines, task add/remove). Best-effort: the
 * mutation already succeeded, so a recompute hiccup must not fail the request.
 */
async function autoRecompute(orgId: string): Promise<void> {
  try {
    await computeOrgSchedule(orgId);
  } catch (e) {
    console.error("[smrtplan] auto-recompute failed:", e);
  }
}

// ── full/lite access ─────────────────────────────────────────────────────────

let smrtplanAppId: string | null = null;
async function getSmrtplanAppId(): Promise<string | null> {
  if (smrtplanAppId) return smrtplanAppId;
  const { data } = await db.from("apps").select("id").eq("slug", "smrtplan").maybeSingle();
  smrtplanAppId = (data?.id as string) ?? null;
  return smrtplanAppId;
}

/** full = explicit app_user_access row 'full', or org owner/admin when no row. */
async function resolveAccessLevel(req: Request): Promise<"full" | "lite"> {
  const appId = await getSmrtplanAppId();
  if (appId) {
    const { data } = await db
      .from("app_user_access")
      .select("access_level")
      .eq("org_id", req.org!.id)
      .eq("app_id", appId)
      .eq("user_id", req.user!.id)
      .maybeSingle();
    if (data?.access_level) return data.access_level as "full" | "lite";
  }
  // No explicit grant → owners/admins plan, plain members consume.
  return req.member!.role === "owner" || req.member!.role === "admin" ? "full" : "lite";
}

/** Gate a write route on full access. */
function requireFull(req: Request, res: Response, next: NextFunction) {
  resolveAccessLevel(req)
    .then((level) => {
      if (level !== "full") {
        return res.status(403).json({ error: "smrtPlan: full (creator) access required" });
      }
      next();
    })
    .catch((e) => res.status(500).json({ error: String(e) }));
}

// ── helpers ──────────────────────────────────────────────────────────────────

const PLAN_FIELDS =
  "id, org_id, parent_id, project_id, title_he, title_en, goal, kind, group_label, " +
  "start_date, end_date, stage, progress, progress_manual, is_critical, color, " +
  "is_private, owner_user_id, created_by, created_at, updated_at";

const PLAN_WRITABLE = new Set([
  "parent_id", "project_id", "title_he", "title_en", "goal", "kind", "group_label",
  "start_date", "end_date", "stage", "progress_manual", "color", "is_private", "owner_user_id",
]);

function pickPlan(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (PLAN_WRITABLE.has(k)) out[k] = v;
  }
  return out;
}

/** Attach effective_progress to a list of plans from the progress view. */
async function withProgress(orgId: string, plans: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  if (plans.length === 0) return plans;
  const { data: prog } = await db
    .from("smrtplan_plan_progress")
    .select("plan_id, effective_progress, computed_progress")
    .eq("org_id", orgId);
  const byId = new Map<string, number>();
  for (const p of prog ?? []) byId.set(p.plan_id as string, (p.effective_progress as number) ?? 0);
  return plans.map((pl) => ({ ...pl, effective_progress: byId.get(pl.id as string) ?? 0 }));
}

// ── access level ─────────────────────────────────────────────────────────────

router.get("/plans/access", async (req: Request, res: Response) => {
  const level = await resolveAccessLevel(req);
  res.json({ access_level: level });
});

// ── list / board / repository ────────────────────────────────────────────────

router.get("/plans", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_plans")
    .select(PLAN_FIELDS)
    .eq("org_id", req.org!.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: await withProgress(req.org!.id, asRows(data)) });
});

router.get("/plans/board", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_plans")
    .select(PLAN_FIELDS)
    .eq("org_id", req.org!.id)
    .not("start_date", "is", null)
    .order("group_label", { ascending: true })
    .order("start_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: await withHealth(req.org!.id, await withProgress(req.org!.id, asRows(data))) });
});

router.get("/plans/milestones", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_milestones")
    .select("id, plan_id, milestone_date, label_he, label_en, color")
    .eq("org_id", req.org!.id)
    .order("milestone_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ milestones: data ?? [] });
});

router.post("/plans/recompute", requireFull, async (req: Request, res: Response) => {
  const summary = await computeOrgSchedule(req.org!.id);
  res.json(summary);
});

router.get("/plans/repository", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_plans")
    .select(PLAN_FIELDS)
    .eq("org_id", req.org!.id)
    .is("start_date", null)
    .order("stage", { ascending: true })
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plans: data ?? [] });
});

// ── single plan CRUD ───────────────────────────────────────────────────────

router.get("/plans/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_plans")
    .select(PLAN_FIELDS)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "plan not found" });
  const [withProg] = await withProgress(req.org!.id, [data as unknown as Row]);
  res.json({ plan: withProg });
});

router.post("/plans", requireFull, async (req: Request, res: Response) => {
  const body = pickPlan(req.body ?? {});
  if (!body.title_he || typeof body.title_he !== "string") {
    return res.status(400).json({ error: "title_he is required" });
  }
  if (!body.kind || (body.kind !== "effort" && body.kind !== "stream")) {
    return res.status(400).json({ error: "kind must be 'effort' or 'stream'" });
  }
  const { data, error } = await db
    .from("smrtplan_plans")
    .insert({
      ...body,
      org_id: req.org!.id,
      created_by: req.user!.id,
      owner_user_id: body.is_private ? req.user!.id : (body.owner_user_id ?? null),
    })
    .select(PLAN_FIELDS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ plan: data });
});

router.patch("/plans/:id", requireFull, async (req: Request, res: Response) => {
  const body = pickPlan(req.body ?? {});
  if (Object.keys(body).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_plans")
    .update(body)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select(PLAN_FIELDS)
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Date / horizon changes shift the whole schedule.
  await autoRecompute(req.org!.id);
  res.json({ plan: data });
});

router.delete("/plans/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtplan_plans")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── effort plan: tasks with needs / handoff ────────────────────────────────

router.get("/plans/:id/tasks", async (req: Request, res: Response) => {
  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id, title, title_he, status, assigned_to_user_id, due_date, latest_finish, latest_start, " +
        "earliest_start, is_critical, duration_days, parent_task_id, assignment_status",
    )
    .eq("organization_id", req.org!.id)
    .eq("plan_id", req.params.id)
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const taskRows = asRows(tasks);
  const ids = taskRows.map((t) => t.id as string);
  const needsByTask = new Map<string, unknown[]>();
  const handoffByTask = new Map<string, unknown[]>();

  if (ids.length > 0) {
    const { data: depsRaw } = await db
      .from("smrtplan_dependencies")
      .select("id, from_id, to_id, satisfied")
      .eq("org_id", req.org!.id)
      .eq("from_type", "task")
      .eq("to_type", "task")
      .or(`from_id.in.(${ids.join(",")}),to_id.in.(${ids.join(",")})`);
    const deps = asRows(depsRaw);

    // Resolve provider/consumer titles in one batch.
    const refIds = new Set<string>();
    for (const d of deps) {
      refIds.add(d.from_id as string);
      refIds.add(d.to_id as string);
    }
    let refs: Row[] = [];
    if (refIds.size) {
      const { data: refsRaw } = await db
        .from("tasks")
        .select("id, title, title_he, assigned_to_user_id, status")
        .eq("organization_id", req.org!.id)
        .in("id", [...refIds]);
      refs = asRows(refsRaw);
    }
    const refMap = new Map<string, Row>();
    for (const r of refs) refMap.set(r.id as string, r);

    for (const d of deps) {
      const consumer = d.from_id as string;
      const provider = d.to_id as string;
      // needs: consumer waits on provider
      if (ids.includes(consumer)) {
        const p = refMap.get(provider);
        const arr = needsByTask.get(consumer) ?? [];
        arr.push({
          dependency_id: d.id,
          task_id: provider,
          title: (p?.title_he as string) || (p?.title as string) || "—",
          satisfied: (d.satisfied as boolean) ?? false,
          source: null,
        });
        needsByTask.set(consumer, arr);
      }
      // handoff: provider feeds consumer
      if (ids.includes(provider)) {
        const c = refMap.get(consumer);
        const arr = handoffByTask.get(provider) ?? [];
        arr.push({
          dependency_id: d.id,
          task_id: consumer,
          title: (c?.title_he as string) || (c?.title as string) || "—",
        });
        handoffByTask.set(provider, arr);
      }
    }
  }

  const enriched = taskRows.map((t) => ({
    ...t,
    needs: needsByTask.get(t.id as string) ?? [],
    handoff: handoffByTask.get(t.id as string) ?? [],
  }));
  res.json({ tasks: enriched });
});

// ── stream plan: matrix ──────────────────────────────────────────────────────

router.get("/plans/:id/matrix", async (req: Request, res: Response) => {
  const planId = req.params.id;
  const [{ data: stages }, { data: episodes }, { data: cells }] = await Promise.all([
    db.from("smrtplan_stages").select("id, plan_id, name_he, name_en, sequence, required_role")
      .eq("org_id", req.org!.id).eq("plan_id", planId).order("sequence", { ascending: true }),
    db.from("smrtplan_episodes").select("id, plan_id, name_he, name_en, family, due_date, sequence")
      .eq("org_id", req.org!.id).eq("plan_id", planId).order("sequence", { ascending: true }),
    db.from("smrtplan_episode_stage_status").select("id, episode_id, stage_id, status, task_id, completed_at")
      .eq("org_id", req.org!.id),
  ]);

  const epIds = new Set((episodes ?? []).map((e) => e.id as string));
  const cellMap: Record<string, unknown> = {};
  for (const c of cells ?? []) {
    if (!epIds.has(c.episode_id as string)) continue;
    cellMap[`${c.episode_id}:${c.stage_id}`] = c;
  }
  res.json({ stages: stages ?? [], episodes: episodes ?? [], cells: cellMap });
});

router.post("/plans/:id/stages", requireFull, async (req: Request, res: Response) => {
  const { name_he, name_en, sequence, required_role } = req.body ?? {};
  if (!name_he) return res.status(400).json({ error: "name_he is required" });
  const { data, error } = await db
    .from("smrtplan_stages")
    .insert({ org_id: req.org!.id, plan_id: req.params.id, name_he, name_en: name_en ?? null,
      sequence: sequence ?? 0, required_role: required_role ?? null })
    .select("id, plan_id, name_he, name_en, sequence, required_role")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ stage: data });
});

router.post("/plans/:id/episodes", requireFull, async (req: Request, res: Response) => {
  const { name_he, name_en, family, due_date, sequence } = req.body ?? {};
  if (!name_he) return res.status(400).json({ error: "name_he is required" });
  const { data, error } = await db
    .from("smrtplan_episodes")
    .insert({ org_id: req.org!.id, plan_id: req.params.id, name_he, name_en: name_en ?? null,
      family: family ?? null, due_date: due_date ?? null, sequence: sequence ?? 0 })
    .select("id, plan_id, name_he, name_en, family, due_date, sequence")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ episode: data });
});

router.patch("/plan-cells/:id", requireFull, async (req: Request, res: Response) => {
  const { status, task_id } = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (status !== undefined) {
    if (!["todo", "prog", "done"].includes(status)) {
      return res.status(400).json({ error: "status must be todo|prog|done" });
    }
    patch.status = status;
    patch.completed_at = status === "done" ? new Date().toISOString() : null;
  }
  if (task_id !== undefined) patch.task_id = task_id;
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_episode_stage_status")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, episode_id, stage_id, status, task_id, completed_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ cell: data });
});

// ── dependencies ─────────────────────────────────────────────────────────────

router.post("/plan-dependencies", requireFull, async (req: Request, res: Response) => {
  const { from_type, from_id, to_type, to_id } = req.body ?? {};
  const ends = ["plan", "stage", "task"];
  if (!ends.includes(from_type) || !ends.includes(to_type) || !from_id || !to_id) {
    return res.status(400).json({ error: "from_type/from_id/to_type/to_id required" });
  }
  const { data, error } = await db
    .from("smrtplan_dependencies")
    .insert({ org_id: req.org!.id, from_type, from_id, to_type, to_id })
    .select("id, from_type, from_id, to_type, to_id, satisfied")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.status(201).json({ dependency: data });
});

router.delete("/plan-dependencies/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtplan_dependencies")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.json({ ok: true });
});

// ── engine recompute (on-demand) ─────────────────────────────────────────────

router.post("/plans/:id/recompute", requireFull, async (req: Request, res: Response) => {
  // Confirm the plan belongs to this org before touching the engine.
  const { data: plan } = await db
    .from("smrtplan_plans")
    .select("id")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (!plan) return res.status(404).json({ error: "plan not found" });
  // Dependencies cross plans, so recompute the whole org graph.
  const summary = await computeOrgSchedule(req.org!.id);
  res.json(summary);
});

// ── milestones (create / edit / delete) ──────────────────────────────────────

router.post("/plans/milestones", requireFull, async (req: Request, res: Response) => {
  const { milestone_date, label_he, label_en, color, plan_id } = req.body ?? {};
  if (!milestone_date || !label_he) {
    return res.status(400).json({ error: "milestone_date and label_he are required" });
  }
  const { data, error } = await db
    .from("smrtplan_milestones")
    .insert({
      org_id: req.org!.id,
      plan_id: plan_id ?? null,
      milestone_date,
      label_he,
      label_en: label_en ?? null,
      color: color ?? null,
      created_by: req.user!.id,
    })
    .select("id, plan_id, milestone_date, label_he, label_en, color")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ milestone: data });
});

router.patch("/plan-milestones/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["milestone_date", "label_he", "label_en", "color", "plan_id"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_milestones")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, plan_id, milestone_date, label_he, label_en, color")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ milestone: data });
});

router.delete("/plan-milestones/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtplan_milestones")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── plan tasks (create / edit / delete) ───────────────────────────────────────

router.post("/plans/:id/tasks", requireFull, async (req: Request, res: Response) => {
  const { title, title_he, due_date, duration_days, parent_task_id } = req.body ?? {};
  if (!title && !title_he) return res.status(400).json({ error: "title or title_he is required" });
  const { data, error } = await db
    .from("tasks")
    .insert({
      organization_id: req.org!.id,
      user_id: req.user!.id,
      plan_id: req.params.id,
      title: title ?? title_he,
      title_he: title_he ?? null,
      status: "inbox",
      is_private: false,
      assignment_status: "accepted",
      due_date: due_date ?? null,
      duration_days: duration_days ?? null,
      parent_task_id: parent_task_id ?? null,
    })
    .select("id, title, title_he, status, due_date, duration_days, parent_task_id, plan_id")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.status(201).json({ task: data });
});

const PLAN_TASK_WRITABLE = new Set([
  "title", "title_he", "due_date", "duration_days", "status",
  "assigned_to_user_id", "parent_task_id",
]);

router.patch("/plan-tasks/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (PLAN_TASK_WRITABLE.has(k)) patch[k] = v;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  // Scope to a task that actually belongs to a plan in this org.
  const { data, error } = await db
    .from("tasks")
    .update(patch)
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .not("plan_id", "is", null)
    .select("id, title, title_he, status, due_date, duration_days, parent_task_id, plan_id")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.json({ task: data });
});

router.delete("/plan-tasks/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("tasks")
    .delete()
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .not("plan_id", "is", null);
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.json({ ok: true });
});

// ── stages / episodes (edit / delete) ─────────────────────────────────────────

router.patch("/plan-stages/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["name_he", "name_en", "sequence", "required_role"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_stages")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, plan_id, name_he, name_en, sequence, required_role")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ stage: data });
});

router.delete("/plan-stages/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtplan_stages").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.patch("/plan-episodes/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["name_he", "name_en", "family", "due_date", "sequence"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_episodes")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, plan_id, name_he, name_en, family, due_date, sequence")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ episode: data });
});

router.delete("/plan-episodes/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtplan_episodes").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── worker capacity (decisions ה.11) ──────────────────────────────────────────

router.get("/plan/capacity", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_capacity")
    .select("user_id, work_days, hours_per_day")
    .eq("org_id", req.org!.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ capacity: data ?? [] });
});

router.put("/plan/capacity/:userId", requireFull, async (req: Request, res: Response) => {
  const { work_days, hours_per_day } = req.body ?? {};
  if (!Array.isArray(work_days) || typeof hours_per_day !== "number") {
    return res.status(400).json({ error: "work_days (array) and hours_per_day (number) are required" });
  }
  // Confirm the target user is a member of this org before storing capacity.
  const { data: member } = await db
    .from("org_members")
    .select("user_id")
    .eq("org_id", req.org!.id)
    .eq("user_id", req.params.userId)
    .maybeSingle();
  if (!member) return res.status(404).json({ error: "user is not a member of this org" });

  const { data, error } = await db
    .from("smrtplan_capacity")
    .upsert(
      {
        org_id: req.org!.id,
        user_id: req.params.userId,
        work_days,
        hours_per_day,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id,user_id" },
    )
    .select("user_id, work_days, hours_per_day")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ capacity: data });
});

// ── task hour estimates catalog ───────────────────────────────────────────────

router.get("/plan/estimates", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_estimates")
    .select("id, name, description, hours")
    .eq("org_id", req.org!.id)
    .order("name", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ estimates: data ?? [] });
});

router.post("/plan/estimates", requireFull, async (req: Request, res: Response) => {
  const { name, description, hours } = req.body ?? {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name is required" });
  const { data, error } = await db
    .from("smrtplan_estimates")
    .insert({
      org_id: req.org!.id,
      name: name.trim(),
      description: description ?? null,
      hours: typeof hours === "number" ? hours : 0,
      created_by: req.user!.id,
    })
    .select("id, name, description, hours")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ estimate: data });
});

router.patch("/plan/estimates/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "description", "hours"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  patch.updated_at = new Date().toISOString();
  const { data, error } = await db
    .from("smrtplan_estimates")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, name, description, hours")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ estimate: data });
});

router.delete("/plan/estimates/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtplan_estimates").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
