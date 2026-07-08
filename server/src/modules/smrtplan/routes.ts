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
import { requireAuth, requireOrg, requireApp, isSuperAdmin } from "../../middleware";
import { notify } from "../../lib/platform";
import { computeOrgSchedule, releaseDependents } from "./engine";

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

  const weight = (t: Row) => Math.max(1, t.duration_days != null ? Number(t.duration_days) : 1);
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

/** Resolve "what's needed to start" (needs) and downstream "handoff" for a set
 *  of tasks from smrtplan_dependencies (task→task). Shared by the plan-tasks
 *  and my-tasks endpoints. */
// Statuses that count as "done" (matches the SQL progress/health views).
const TASK_DONE_STATUSES = new Set(["completed", "archived", "dismissed"]);

async function attachNeedsHandoff(orgId: string, taskRows: Row[]): Promise<Row[]> {
  const ids = taskRows.map((t) => t.id as string);
  if (ids.length === 0) return taskRows.map((t) => ({ ...t, needs: [], handoff: [] }));

  const { data: depsRaw } = await db
    .from("smrtplan_dependencies")
    .select("id, from_id, to_id, satisfied, lag_days")
    .eq("org_id", orgId)
    .eq("from_type", "task")
    .eq("to_type", "task")
    .or(`from_id.in.(${ids.join(",")}),to_id.in.(${ids.join(",")})`);
  const deps = asRows(depsRaw);

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
      .eq("organization_id", orgId)
      .in("id", [...refIds]);
    refs = asRows(refsRaw);
  }
  const refMap = new Map<string, Row>();
  for (const r of refs) refMap.set(r.id as string, r);

  const idSet = new Set(ids);
  const needsByTask = new Map<string, unknown[]>();
  const handoffByTask = new Map<string, unknown[]>();
  for (const d of deps) {
    const consumer = d.from_id as string;
    const provider = d.to_id as string;
    if (idSet.has(consumer)) {
      const p = refMap.get(provider);
      const arr = needsByTask.get(consumer) ?? [];
      const satisfied = (d.satisfied as boolean) ?? false;
      arr.push({
        dependency_id: d.id,
        task_id: provider,
        title: (p?.title_he as string) || (p?.title as string) || "—",
        satisfied,
        // satisfied only flips on completion; a satisfied edge whose provider
        // is no longer done means the provider was reopened — the consumer is
        // working off an input that's back in progress.
        provider_reopened: satisfied && !!p && !TASK_DONE_STATUSES.has(p.status as string),
        lag_days: (d.lag_days as number | null) ?? 0,
        source: null,
        // The provider task's assignee, so the consumer's "to start I need" list
        // can show who owns each input (resolved to a name client-side).
        assignee_user_id: (p?.assigned_to_user_id as string | null) ?? null,
      });
      needsByTask.set(consumer, arr);
    }
    if (idSet.has(provider)) {
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
  // Capability (plan) providers: a task can depend on a whole plan/capability
  // (to_type = 'plan'). It "arrives" when that plan is done AND available; a
  // done-but-unavailable capability re-blocks the open dependent.
  const { data: planDepsRaw } = await db
    .from("smrtplan_dependencies")
    .select("id, from_id, to_id, lag_days")
    .eq("org_id", orgId)
    .eq("from_type", "task")
    .eq("to_type", "plan")
    .in("from_id", ids);
  const planDeps = asRows(planDepsRaw);
  if (planDeps.length) {
    const planIds = [...new Set(planDeps.map((d) => d.to_id as string))];
    const { data: planRows } = await db
      .from("smrtplan_plans")
      .select("id, title_he, title_en, is_capability, status, is_available")
      .eq("org_id", orgId)
      .in("id", planIds);
    const pMap = new Map(asRows(planRows).map((p) => [p.id as string, p]));
    for (const d of planDeps) {
      const consumer = d.from_id as string;
      if (!idSet.has(consumer)) continue;
      const p = pMap.get(d.to_id as string);
      const done = (p?.status as string) === "done";
      const available = (p?.is_available as boolean | null) ?? true;
      const arr = needsByTask.get(consumer) ?? [];
      arr.push({
        dependency_id: d.id,
        task_id: null,
        provider_kind: "plan",
        plan_id: d.to_id,
        title: (p?.title_he as string) || (p?.title_en as string) || "—",
        satisfied: done && available,
        unavailable: !!(p?.is_capability as boolean) && !available,
        lag_days: (d.lag_days as number | null) ?? 0,
        source: null,
      });
      needsByTask.set(consumer, arr);
    }
  }

  return taskRows.map((t) => ({
    ...t,
    needs: needsByTask.get(t.id as string) ?? [],
    handoff: handoffByTask.get(t.id as string) ?? [],
  }));
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

/** Resolve a role's default staffing: verify the role belongs to the org and
 *  return its primary member (the fallback assignee). Shared by task-create and
 *  template-apply so both staff a role the same way. */
async function roleDefaultAssignee(
  orgId: string,
  roleId: string | null,
): Promise<{ validRoleId: string | null; primary: string | null }> {
  if (!roleId) return { validRoleId: null, primary: null };
  const { data: role } = await db.from("smrtplan_roles").select("id").eq("org_id", orgId).eq("id", roleId).maybeSingle();
  if (!role) return { validRoleId: null, primary: null };
  const { data: primary } = await db
    .from("smrtplan_role_members")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("role_id", roleId)
    .eq("is_primary", true)
    .maybeSingle();
  return { validRoleId: roleId, primary: (primary?.user_id as string | null) ?? null };
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
  "start_date, end_date, stage, status, is_capability, is_available, progress, progress_manual, is_critical, color, " +
  "is_private, owner_user_id, manager_user_id, created_by, created_at, updated_at";

const PLAN_WRITABLE = new Set([
  "parent_id", "project_id", "title_he", "title_en", "goal", "kind", "group_label",
  "start_date", "end_date", "stage", "status", "is_capability", "is_available",
  "progress_manual", "color", "is_private", "owner_user_id", "manager_user_id",
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

/** IDs of plans whose tasks must stay SILENT — i.e. drafts, not yet approved.
 *  Used to keep draft-plan tasks out of every list a worker/teammate sees, so a
 *  plan can be built freely before it becomes real work. Approving the plan
 *  (status → active) un-hides them instantly, with no task mutation. */
async function silentPlanIds(orgId: string): Promise<string[]> {
  const { data } = await db.from("smrtplan_plans").select("id").eq("org_id", orgId).eq("status", "draft");
  return asRows(data).map((p) => p.id as string);
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

// Stages across the org's board plans — drives the per-stage squares on each
// row. Returned for every plan so the board can render a square per stage.
router.get("/plans/board-stages", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_stages")
    .select("id, plan_id, name_he, name_en, sequence, default_duration_days, start_date, end_date")
    .eq("org_id", req.org!.id)
    .order("plan_id", { ascending: true })
    .order("sequence", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ stages: data ?? [] });
});

router.get("/plans/milestones", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_milestones")
    .select("id, plan_id, milestone_date, label_he, label_en, color, constrains_user_id")
    .eq("org_id", req.org!.id)
    .order("milestone_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ milestones: data ?? [] });
});

// Blocked/no-work days for the board's holiday markers: global Israeli yom tov
// (org_id NULL) plus this org's own rows. The Mon–Fri weekend is drawn client-
// side, so only the calendar holidays come from here.
router.get("/plans/holidays", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_blocked_days")
    .select("blocked_date, reason, kind, org_id")
    .or(`org_id.is.null,org_id.eq.${req.org!.id}`)
    .order("blocked_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ holidays: data ?? [] });
});

router.post("/plans/recompute", requireFull, async (req: Request, res: Response) => {
  try {
    const summary = await computeOrgSchedule(req.org!.id);
    res.json(summary);
  } catch (e) {
    console.error("[smrtplan] recompute failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : "recompute failed" });
  }
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
  // Only the plan's window / kind feeds the engine; a title/goal/color/status/
  // group edit returns immediately without an org-wide reschedule.
  if ("start_date" in body || "end_date" in body || "kind" in body) await autoRecompute(req.org!.id);
  res.json({ plan: data });
});

router.delete("/plans/:id", requireFull, async (req: Request, res: Response) => {
  // Opt-in cascade: also remove the plan's tasks (the FK is SET NULL, which would
  // otherwise orphan them) plus the polymorphic dependency edges that point at
  // those tasks or at this plan (no FK, so they'd linger). Stages/episodes
  // cascade via their own FK.
  if (req.query.cascade === "tasks") {
    const { data: planTasks } = await db
      .from("tasks").select("id").eq("organization_id", req.org!.id).eq("plan_id", req.params.id);
    const ids = asRows(planTasks).map((r) => r.id as string);
    const refs = [...ids, req.params.id];
    if (refs.length) {
      const { error: depDelErr } = await db
        .from("smrtplan_dependencies")
        .delete()
        .eq("org_id", req.org!.id)
        .or(`from_id.in.(${refs.join(",")}),to_id.in.(${refs.join(",")})`);
      if (depDelErr) console.error("[smrtplan] plan-delete dependency cascade failed:", depDelErr);
    }
    const { error: taskDelErr } = await db
      .from("tasks").delete().eq("organization_id", req.org!.id).eq("plan_id", req.params.id);
    if (taskDelErr) console.error("[smrtplan] plan-delete task cascade failed:", taskDelErr);
  }
  const { error } = await db
    .from("smrtplan_plans")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── plan tasks (effort = contained by plan_id; roster = aggregated by assignee) ──

router.get("/plans/:id/tasks", async (req: Request, res: Response) => {
  const { data: plan } = await db
    .from("smrtplan_plans")
    .select("kind, owner_user_id")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();

  const select =
    "id, title, title_he, status, assigned_to_user_id, due_date, latest_finish, latest_start, " +
    "earliest_start, is_critical, duration_days, duration_manual, estimated_hours, parent_task_id, plan_id, stage_id, checklist, assignment_status";

  let query = db.from("tasks").select(select).eq("organization_id", req.org!.id);
  if (plan?.kind === "roster") {
    // A roster aggregates its owner's tasks across all plans (the "design"
    // view): nothing to show until it has an owner.
    if (!plan.owner_user_id) return res.json({ tasks: [] });
    query = query.not("plan_id", "is", null).eq("assigned_to_user_id", plan.owner_user_id);
  } else {
    query = query.eq("plan_id", req.params.id);
  }
  const { data: tasks, error } = await query.order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  // Roster tasks live in other plans, so show which plan each is in.
  const enriched = await attachNeedsHandoff(req.org!.id, asRows(tasks));
  res.json({ tasks: plan?.kind === "roster" ? await attachPlanTitles(req.org!.id, enriched) : enriched });
});

// ── dependency candidates: any org task (cross-plan) + capabilities ──────────
// Powers the dependency picker so a task can depend on a task in ANOTHER plan,
// or on a whole capability (a reusable tool plan). The caller filters out the
// current task and groups by plan.
router.get("/plans/:id/dep-candidates", requireFull, async (req: Request, res: Response) => {
  const [{ data: taskRows }, { data: planRows }] = await Promise.all([
    db
      .from("tasks")
      .select("id, title, title_he, plan_id")
      .eq("organization_id", req.org!.id)
      .not("plan_id", "is", null)
      .order("created_at", { ascending: true }),
    db
      .from("smrtplan_plans")
      .select("id, title_he, title_en, is_capability")
      .eq("org_id", req.org!.id),
  ]);
  const planById = new Map(asRows(planRows).map((p) => [p.id as string, p]));
  const tasks = asRows(taskRows).map((t) => {
    const p = planById.get(t.plan_id as string);
    return {
      id: t.id,
      title: t.title,
      title_he: t.title_he,
      plan_id: t.plan_id,
      plan_title_he: (p?.title_he as string) ?? null,
      plan_title_en: (p?.title_en as string) ?? null,
    };
  });
  const capabilities = asRows(planRows)
    .filter((p) => p.is_capability)
    .map((p) => ({ id: p.id, title_he: p.title_he, title_en: p.title_en }));
  res.json({ tasks, capabilities });
});

// ── all plan tasks across the org (the editable spreadsheet view) ────────────
// One flat list of every plan-task (incl. drafts) with its plan title, needs/
// handoff, and assignee — grouped client-side into the cross-plan table.
router.get("/plan/all-tasks", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("tasks")
    .select(
      "id, title, title_he, status, assigned_to_user_id, due_date, latest_finish, latest_start, " +
        "earliest_start, is_critical, duration_days, duration_manual, estimated_hours, parent_task_id, plan_id, stage_id, " +
        "linked_drive_docs, task_materials, source_messages(id, source_type, source_id, source_url, serial_display)",
    )
    .eq("organization_id", req.org!.id)
    .not("plan_id", "is", null)
    .order("plan_id", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: await attachPlanTitles(req.org!.id, await attachNeedsHandoff(req.org!.id, asRows(data))) });
});

// ── current user's plan tasks, in ready/blocked/done zones (the worker view) ──
const MY_TASK_FIELDS =
  "id, title, title_he, status, assigned_to_user_id, due_date, latest_finish, latest_start, " +
  "earliest_start, is_critical, duration_days, duration_manual, estimated_hours, parent_task_id, plan_id, stage_id, " +
  "assignment_status, " +
  // Desk-row fields: my plan tasks are merged into the unified /tasks desk,
  // whose rows need these to sort, age and render like any other task.
  // planned_for = the daily-method "picked for today" flag: the desk shows a
  // plan task only when it's set to today, and the inbox filters picked ones out.
  "size, context, planned_for, today_position, woke_from_snooze_at, last_interaction_at, created_at, priority, " +
  "description, has_unread_update, recurrence_rule";

/** Attach each task's plan title (so a worker/me view can show which plan it's in). */
async function attachPlanTitles(orgId: string, tasks: Row[]): Promise<Row[]> {
  const planIds = [...new Set(tasks.map((t) => t.plan_id as string).filter(Boolean))];
  if (planIds.length === 0) return tasks;
  const { data } = await db
    .from("smrtplan_plans")
    .select("id, title_he, title_en")
    .eq("org_id", orgId)
    .in("id", planIds);
  const byId = new Map(asRows(data).map((p) => [p.id as string, p]));
  for (const t of tasks) {
    const p = byId.get(t.plan_id as string);
    t.plan_title_he = (p?.title_he as string) ?? null;
    t.plan_title_en = (p?.title_en as string) ?? null;
  }
  return tasks;
}

/** Attach each task's stage (banner) name, so worker views can show
 *  "plan / stage" on the chip (e.g. כלי AI / ג'מיני ג'ם). */
async function attachStageTitles(orgId: string, tasks: Row[]): Promise<Row[]> {
  const stageIds = [...new Set(tasks.map((t) => t.stage_id as string).filter(Boolean))];
  if (stageIds.length === 0) return tasks;
  const { data } = await db
    .from("smrtplan_stages")
    .select("id, name_he, name_en")
    .eq("org_id", orgId)
    .in("id", stageIds);
  const byId = new Map(asRows(data).map((s) => [s.id as string, s]));
  for (const t of tasks) {
    const s = byId.get(t.stage_id as string);
    t.stage_name_he = (s?.name_he as string) ?? null;
    t.stage_name_en = (s?.name_en as string) ?? null;
  }
  return tasks;
}

router.get("/plan/my-tasks", async (req: Request, res: Response) => {
  // Mine = assigned to me, OR unassigned tasks I created (an unassigned plan
  // task still belongs to its owner — it shouldn't fall through the cracks).
  const uid = req.user!.id;
  const silent = await silentPlanIds(req.org!.id);
  let q = db
    .from("tasks")
    .select(MY_TASK_FIELDS)
    .eq("organization_id", req.org!.id)
    .not("plan_id", "is", null)
    .or(`assigned_to_user_id.eq.${uid},and(assigned_to_user_id.is.null,user_id.eq.${uid})`)
    // Proposed assignments live in the inbox (accept/decline) and declined
    // ones are not my work — neither belongs in the working list.
    .not("assignment_status", "in", "(proposed,declined)");
  // Every row here has a non-null plan_id, so a plain not-in is null-safe.
  if (silent.length) q = q.not("plan_id", "in", `(${silent.join(",")})`);
  const { data, error } = await q.order("due_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: await attachStageTitles(req.org!.id, await attachPlanTitles(req.org!.id, await attachNeedsHandoff(req.org!.id, asRows(data)))) });
});

/** GET /plan/proposals — plan tasks proposed TO me, awaiting accept/decline.
 *  Surfaced in the platform inbox alongside AI suggestions. */
router.get("/plan/proposals", async (req: Request, res: Response) => {
  const silent = await silentPlanIds(req.org!.id);
  let q = db
    .from("tasks")
    .select(MY_TASK_FIELDS + ", proposed_by, proposed_at, description")
    .eq("organization_id", req.org!.id)
    .not("plan_id", "is", null)
    .eq("assigned_to_user_id", req.user!.id)
    .eq("assignment_status", "proposed");
  if (silent.length) q = q.not("plan_id", "in", `(${silent.join(",")})`);
  const { data, error } = await q.order("due_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: await attachStageTitles(req.org!.id, await attachPlanTitles(req.org!.id, asRows(data))) });
});

/** POST /plan-tasks/:id/assignment-response  body: { accept: boolean }
 *  The assignee's own accept/decline on a proposed plan task. Deliberately NOT
 *  behind requireFull — responding to a proposal is the worker's call. */
router.post("/plan-tasks/:id/assignment-response", async (req: Request, res: Response) => {
  const accept = req.body?.accept === true;
  const { data, error } = await db
    .from("tasks")
    .update({
      assignment_status: accept ? "accepted" : "declined",
      accepted_at: accept ? new Date().toISOString() : null,
    })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .eq("assigned_to_user_id", req.user!.id)
    .eq("assignment_status", "proposed")
    .select("id, assignment_status")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "proposal not found (or already answered)" });

  // A declined task needs the planner's attention — tell the plan's manager.
  if (!accept) {
    const { data: task } = await db
      .from("tasks").select("title_he, title, plan_id").eq("id", req.params.id).maybeSingle();
    const { data: plan } = task?.plan_id
      ? await db.from("smrtplan_plans").select("manager_user_id, title_he").eq("id", task.plan_id as string).maybeSingle()
      : { data: null };
    if (plan?.manager_user_id) {
      await notify(req.org!.id, plan.manager_user_id as string, {
        app_slug: "smrtplan",
        type: "action_required",
        title: `שיבוץ נדחה: ${(task?.title_he as string) || (task?.title as string) || ""}`,
        body: `העובד דחה את השיבוץ בתוכנית "${(plan.title_he as string) ?? ""}"`,
        entity_type: "task",
        entity_id: req.params.id,
        from_user_id: req.user!.id,
      });
    }
  }

  res.json({ task: data });
});

// A specific worker's tasks across all plans (planner view, fix #4). "Design"
// etc. are filtered views by assignee — work lives in its real plan, surfaced
// here because the assignee is that worker.
router.get("/plan/worker-tasks/:userId", requireFull, async (req: Request, res: Response) => {
  const silent = await silentPlanIds(req.org!.id);
  let q = db
    .from("tasks")
    .select(MY_TASK_FIELDS)
    .eq("organization_id", req.org!.id)
    .not("plan_id", "is", null)
    .eq("assigned_to_user_id", req.params.userId);
  if (silent.length) q = q.not("plan_id", "in", `(${silent.join(",")})`);
  const { data, error } = await q.order("due_date", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: await attachStageTitles(req.org!.id, await attachPlanTitles(req.org!.id, await attachNeedsHandoff(req.org!.id, asRows(data)))) });
});

// ── stream plan: matrix ──────────────────────────────────────────────────────

router.get("/plans/:id/matrix", async (req: Request, res: Response) => {
  const planId = req.params.id;
  const [{ data: stages }, { data: episodes }, { data: cells }] = await Promise.all([
    db.from("smrtplan_stages").select("id, plan_id, name_he, name_en, sequence, required_role, default_duration_days")
      .eq("org_id", req.org!.id).eq("plan_id", planId).order("sequence", { ascending: true }),
    db.from("smrtplan_episodes").select("id, plan_id, name_he, name_en, family, due_date, sequence")
      .eq("org_id", req.org!.id).eq("plan_id", planId).order("sequence", { ascending: true }),
    db.from("smrtplan_episode_stage_status").select("id, episode_id, stage_id, status, task_id, completed_at")
      .eq("org_id", req.org!.id),
  ]);

  const epIds = new Set((episodes ?? []).map((e) => e.id as string));
  const cellMap: Record<string, unknown> = {};
  const taskIds = new Set<string>();
  for (const c of cells ?? []) {
    if (!epIds.has(c.episode_id as string)) continue;
    cellMap[`${c.episode_id}:${c.stage_id}`] = c;
    if (c.task_id) taskIds.add(c.task_id as string);
  }
  // Summaries of the tasks linked to cells, so the matrix can show/open them.
  const taskMap: Record<string, unknown> = {};
  if (taskIds.size > 0) {
    const { data: taskRows } = await db
      .from("tasks")
      .select("id, title, title_he, status, assigned_to_user_id, due_date")
      .eq("organization_id", req.org!.id)
      .in("id", [...taskIds]);
    for (const t of asRows(taskRows)) taskMap[t.id as string] = t;
  }
  res.json({ stages: stages ?? [], episodes: episodes ?? [], cells: cellMap, tasks: taskMap });
});

// Upsert a matrix cell (so status/linking works even before a cell row exists).
router.post("/plan-cells", requireFull, async (req: Request, res: Response) => {
  const { episode_id, stage_id, status } = req.body ?? {};
  if (!episode_id || !stage_id) return res.status(400).json({ error: "episode_id and stage_id required" });
  if (status !== undefined && !["todo", "prog", "done"].includes(status)) {
    return res.status(400).json({ error: "status must be todo|prog|done" });
  }
  const { data, error } = await db
    .from("smrtplan_episode_stage_status")
    .upsert(
      {
        org_id: req.org!.id,
        episode_id,
        stage_id,
        status: status ?? "todo",
        completed_at: status === "done" ? new Date().toISOString() : null,
      },
      { onConflict: "episode_id,stage_id" },
    )
    .select("id, episode_id, stage_id, status, task_id, completed_at")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ cell: data });
});

router.post("/plans/:id/stages", requireFull, async (req: Request, res: Response) => {
  const { name_he, name_en, sequence, required_role, default_duration_days, start_date, end_date } = req.body ?? {};
  if (!name_he) return res.status(400).json({ error: "name_he is required" });
  const { data, error } = await db
    .from("smrtplan_stages")
    .insert({ org_id: req.org!.id, plan_id: req.params.id, name_he, name_en: name_en ?? null,
      sequence: sequence ?? 0, required_role: required_role ?? null,
      default_duration_days: default_duration_days != null ? Number(default_duration_days) : null,
      start_date: start_date ?? null, end_date: end_date ?? null })
    .select("id, plan_id, name_he, name_en, sequence, required_role, default_duration_days, start_date, end_date")
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
  const { from_type, from_id, to_type, to_id, lag_days } = req.body ?? {};
  const ends = ["plan", "stage", "task"];
  if (!ends.includes(from_type) || !ends.includes(to_type) || !from_id || !to_id) {
    return res.status(400).json({ error: "from_type/from_id/to_type/to_id required" });
  }
  const { data, error } = await db
    .from("smrtplan_dependencies")
    .insert({ org_id: req.org!.id, from_type, from_id, to_type, to_id, lag_days: Math.max(0, Math.round(Number(lag_days)) || 0) })
    .select("id, from_type, from_id, to_type, to_id, satisfied, lag_days")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.status(201).json({ dependency: data });
});

router.patch("/plan-dependencies/:id", requireFull, async (req: Request, res: Response) => {
  const { lag_days } = req.body ?? {};
  if (lag_days == null || isNaN(Number(lag_days))) return res.status(400).json({ error: "lag_days (number) is required" });
  const { data, error } = await db
    .from("smrtplan_dependencies")
    .update({ lag_days: Math.max(0, Math.round(Number(lag_days))) })
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, from_type, from_id, to_type, to_id, satisfied, lag_days")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.json({ dependency: data });
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
  const { milestone_date, label_he, label_en, color, plan_id, constrains_user_id } = req.body ?? {};
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
      constrains_user_id: constrains_user_id ?? null,
      created_by: req.user!.id,
    })
    .select("id, plan_id, milestone_date, label_he, label_en, color, constrains_user_id")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Only a worker-constraining milestone shifts the schedule; a plain label
  // milestone appears instantly with no org-wide reschedule.
  if (data?.constrains_user_id) await autoRecompute(req.org!.id);
  res.status(201).json({ milestone: data });
});

router.patch("/plan-milestones/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["milestone_date", "label_he", "label_en", "color", "plan_id", "constrains_user_id"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_milestones")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, plan_id, milestone_date, label_he, label_en, color, constrains_user_id")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Reschedule only when a worker-constraint is (or was) in play.
  if (data?.constrains_user_id || "constrains_user_id" in (req.body ?? {})) await autoRecompute(req.org!.id);
  res.json({ milestone: data });
});

router.delete("/plan-milestones/:id", requireFull, async (req: Request, res: Response) => {
  const { data: existing } = await db
    .from("smrtplan_milestones")
    .select("constrains_user_id")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  const { error } = await db
    .from("smrtplan_milestones")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  if (existing?.constrains_user_id) await autoRecompute(req.org!.id);
  res.json({ ok: true });
});

// ── plan tasks (create / edit / delete) ───────────────────────────────────────

router.post("/plans/:id/tasks", requireFull, async (req: Request, res: Response) => {
  const { title, title_he, due_date, duration_days, estimated_hours, assigned_to_user_id, parent_task_id, role_id, status, stage_id } = req.body ?? {};
  if (!title && !title_he) return res.status(400).json({ error: "title or title_he is required" });
  // Default staffing: a task with a role but no explicit assignee falls back to
  // the role's primary member. An explicit assignee always wins.
  const { validRoleId, primary } = await roleDefaultAssignee(req.org!.id, (role_id as string | null) ?? null);
  const assignee = (assigned_to_user_id as string | null) || primary;
  const { data, error } = await db
    .from("tasks")
    .insert({
      organization_id: req.org!.id,
      user_id: req.user!.id,
      plan_id: req.params.id,
      title: title ?? title_he,
      title_he: title_he ?? null,
      status: typeof status === "string" ? status : "inbox",
      is_private: false,
      assignment_status: "accepted",
      due_date: due_date ?? null,
      duration_days: duration_days ?? null,
      duration_manual: duration_days != null,
      estimated_hours: estimated_hours ?? null,
      assigned_to_user_id: assignee,
      parent_task_id: parent_task_id ?? null,
      role_id: validRoleId,
      stage_id: stage_id ?? null,
    })
    .select("id, title, title_he, status, due_date, duration_days, estimated_hours, parent_task_id, plan_id, role_id, stage_id")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  await autoRecompute(req.org!.id);
  res.status(201).json({ task: data });
});

const PLAN_TASK_WRITABLE = new Set([
  "title", "title_he", "description", "due_date", "duration_days", "duration_manual",
  "estimated_hours", "status", "assigned_to_user_id", "parent_task_id", "role_id",
  "task_materials", "stage_id",
]);

// Lightweight validation for task_materials (links/notes attached to a task),
// mirroring the smrtTask route's rules: typed items with id + title, size-capped.
const MATERIAL_TYPES = new Set(["note", "link", "file", "contact"]);
function validateTaskMaterials(value: unknown): string | null {
  if (!Array.isArray(value)) return "task_materials must be an array";
  if (value.length > 200) return "task_materials exceeds 200 items";
  if (JSON.stringify(value).length > 64 * 1024) return "task_materials exceeds size limit";
  for (let i = 0; i < value.length; i++) {
    const it = value[i] as Record<string, unknown> | null;
    if (!it || typeof it !== "object") return `task_materials[${i}] must be an object`;
    if (typeof it.id !== "string" || !it.id) return `task_materials[${i}].id required`;
    if (typeof it.type !== "string" || !MATERIAL_TYPES.has(it.type)) return `task_materials[${i}].type invalid`;
    if (typeof it.title !== "string") return `task_materials[${i}].title must be a string`;
    if (it.url !== undefined && typeof it.url !== "string") return `task_materials[${i}].url must be a string`;
  }
  return null;
}
// Fields that change the schedule graph — only these need an engine recompute.
// A title/status edit returns immediately (no org-wide reschedule). assignee is
// included because an estimated-hours task's duration = hours / that person's
// capacity, so reassigning can shift its dates.
const TASK_SCHED_FIELDS = new Set(["due_date", "duration_days", "duration_manual", "estimated_hours", "parent_task_id", "assigned_to_user_id"]);

// A status flip INTO the done set via the generic PATCH must behave exactly
// like /plan-tasks/:id/done — release dependents + recompute — otherwise
// successor tasks stay blocked and matrix cells never flip.
router.patch("/plan-tasks/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (PLAN_TASK_WRITABLE.has(k)) patch[k] = v;
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  if ("task_materials" in patch) {
    const err = validateTaskMaterials(patch.task_materials);
    if (err) return res.status(400).json({ error: err });
  }
  // When the status changes, read the current one first to detect a
  // done-transition (in either direction).
  let wasDone: boolean | null = null;
  if (typeof patch.status === "string") {
    const { data: cur, error: curErr } = await db
      .from("tasks")
      .select("status")
      .eq("organization_id", req.org!.id)
      .eq("id", req.params.id)
      .not("plan_id", "is", null)
      .maybeSingle();
    if (curErr) return res.status(500).json({ error: curErr.message });
    if (!cur) return res.status(404).json({ error: "task not found" });
    wasDone = TASK_DONE_STATUSES.has(cur.status as string);
  }
  // Scope to a task that actually belongs to a plan in this org.
  const { data, error } = await db
    .from("tasks")
    .update(patch)
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .not("plan_id", "is", null)
    .select("id, title, title_he, status, due_date, duration_days, parent_task_id, plan_id, task_materials")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  const nowDone = typeof patch.status === "string" ? TASK_DONE_STATUSES.has(patch.status) : null;
  const becameDone = wasDone === false && nowDone === true;
  const reopened = wasDone === true && nowDone === false;
  if (becameDone) {
    // Best-effort like autoRecompute: the status update already succeeded, so a
    // release hiccup must not fail the request.
    try {
      await releaseDependents(req.org!.id, req.params.id); // unblock successors
    } catch (e) {
      console.error("[smrtplan] release-dependents failed:", e);
    }
  }
  if (becameDone || reopened || Object.keys(patch).some((k) => TASK_SCHED_FIELDS.has(k))) {
    await autoRecompute(req.org!.id);
  }
  res.json({ task: data });
});

/**
 * GET /plan-tasks/:id/detail — read-only task card for the worker views: the
 * task itself plus description, materials, drive docs, checklist, its subtasks,
 * and needs/handoff. Open to any org member with smrtPlan access (the list
 * endpoints already expose these tasks; this just adds their content).
 */
router.get("/plan-tasks/:id/detail", async (req: Request, res: Response) => {
  const { data: task, error } = await db
    .from("tasks")
    .select(
      MY_TASK_FIELDS +
        ", description, task_materials, linked_drive_docs, checklist, " +
        "source_messages(id, source_type, source_id, source_url, serial_display)",
    )
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .not("plan_id", "is", null)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!task) return res.status(404).json({ error: "task not found" });

  const { data: subs } = await db
    .from("tasks")
    .select("id, title, title_he, status, assigned_to_user_id, due_date, latest_finish")
    .eq("organization_id", req.org!.id)
    .eq("parent_task_id", req.params.id)
    .order("created_at", { ascending: true });

  const [enriched] = await attachStageTitles(
    req.org!.id,
    await attachPlanTitles(req.org!.id, await attachNeedsHandoff(req.org!.id, [task as unknown as Row])),
  );
  res.json({ task: enriched, subtasks: subs ?? [] });
});

/**
 * PATCH /plan-tasks/:id/done — mark a plan task complete / reopen it. Unlike the
 * full editor, this is allowed for the task's ASSIGNEE (so a worker can tick off
 * their own task) and for super-admins (any task), in addition to full-access
 * planners. Completing releases its dependents.
 */
router.patch("/plan-tasks/:id/done", async (req: Request, res: Response) => {
  const done = !!(req.body ?? {}).done;
  const { data: task } = await db
    .from("tasks")
    .select("id, assigned_to_user_id")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .not("plan_id", "is", null)
    .maybeSingle();
  if (!task) return res.status(404).json({ error: "task not found" });
  const level = await resolveAccessLevel(req);
  const allowed = level === "full" || (task.assigned_to_user_id as string | null) === req.user!.id || (await isSuperAdmin(req.user!));
  if (!allowed) return res.status(403).json({ error: "not allowed to complete this task" });
  const { data, error } = await db
    .from("tasks")
    .update({ status: done ? "completed" : "inbox" })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, status")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  if (done) {
    // Best-effort like autoRecompute: the status update already succeeded, so a
    // release hiccup must not fail the request.
    try {
      await releaseDependents(req.org!.id, req.params.id); // unblock successors
    } catch (e) {
      console.error("[smrtplan] release-dependents failed:", e);
    }
  }
  await autoRecompute(req.org!.id);
  res.json({ task: data });
});

/**
 * GET /plan-tasks/:id/released-dependents — the consumer tasks whose dependency
 * on this task was already released (satisfied = true). Surfaced after a
 * reopen so the planner sees what kept running and can decide to re-block.
 */
router.get("/plan-tasks/:id/released-dependents", async (req: Request, res: Response) => {
  const { data: edges, error } = await db
    .from("smrtplan_dependencies")
    .select("id, from_id")
    .eq("org_id", req.org!.id)
    .eq("from_type", "task")
    .eq("to_type", "task")
    .eq("to_id", req.params.id)
    .eq("satisfied", true);
  if (error) return res.status(500).json({ error: error.message });
  if (!edges || edges.length === 0) return res.json({ dependents: [] });
  const { data: consumers, error: cErr } = await db
    .from("tasks")
    .select("id, title, title_he, status")
    .eq("organization_id", req.org!.id)
    .in("id", edges.map((e) => e.from_id as string));
  if (cErr) return res.status(500).json({ error: cErr.message });
  res.json({ dependents: consumers ?? [] });
});

/**
 * POST /plan-tasks/:id/reblock — after a reopen, flip satisfied back to false
 * on this task's released edges, but ONLY for consumers that haven't started
 * yet (status inbox). In-progress and done consumers are never yanked back —
 * the human decides those case by case. Allowed for the same actors as /done
 * (full planner, the task's assignee, super-admin), since it's the follow-up
 * to their own reopen.
 */
router.post("/plan-tasks/:id/reblock", async (req: Request, res: Response) => {
  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id, assigned_to_user_id, status")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .not("plan_id", "is", null)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found" });
  const level = await resolveAccessLevel(req);
  const allowed = level === "full" || (task.assigned_to_user_id as string | null) === req.user!.id || (await isSuperAdmin(req.user!));
  if (!allowed) return res.status(403).json({ error: "not allowed to re-block" });
  // The provider may have been re-completed while the toast was on screen —
  // re-blocking edges of a DONE provider would wrongly block its consumers.
  if (TASK_DONE_STATUSES.has(task.status as string)) return res.json({ reblocked: 0 });

  const { data: edges, error } = await db
    .from("smrtplan_dependencies")
    .select("id, from_id")
    .eq("org_id", req.org!.id)
    .eq("from_type", "task")
    .eq("to_type", "task")
    .eq("to_id", req.params.id)
    .eq("satisfied", true);
  if (error) return res.status(500).json({ error: error.message });
  let reblocked = 0;
  if (edges && edges.length > 0) {
    const { data: notStarted, error: nErr } = await db
      .from("tasks")
      .select("id")
      .eq("organization_id", req.org!.id)
      .in("id", edges.map((e) => e.from_id as string))
      .eq("status", "inbox");
    if (nErr) return res.status(500).json({ error: nErr.message });
    const ids = new Set((notStarted ?? []).map((r) => r.id as string));
    const edgeIds = edges.filter((e) => ids.has(e.from_id as string)).map((e) => e.id as string);
    if (edgeIds.length > 0) {
      const { error: uErr } = await db
        .from("smrtplan_dependencies")
        .update({ satisfied: false })
        .eq("org_id", req.org!.id)
        .in("id", edgeIds);
      if (uErr) return res.status(500).json({ error: uErr.message });
      reblocked = edgeIds.length;
      await autoRecompute(req.org!.id);
    }
  }
  res.json({ reblocked });
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
  for (const k of ["name_he", "name_en", "sequence", "required_role", "start_date", "end_date"]) {
    if (k in (req.body ?? {})) patch[k] = req.body[k];
  }
  // A stage's default duration drives every cell that doesn't pin its own.
  if ("default_duration_days" in (req.body ?? {})) {
    const v = req.body.default_duration_days;
    patch.default_duration_days = v == null || v === "" ? null : Number(v);
  }
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_stages")
    .update(patch)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, plan_id, name_he, name_en, sequence, required_role, default_duration_days, start_date, end_date")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Only a default-duration change reflows the schedule; a timeline-window /
  // rename edit (start_date/end_date/name) doesn't touch the engine.
  if ("default_duration_days" in (req.body ?? {})) await autoRecompute(req.org!.id);
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

// ── roles + default staffing ───────────────────────────────────────────────
// A role (designer / editor / tool-builder) maps to one or more people, one of
// whom is the primary (the default assignee). Creating a task with a role and
// no explicit assignee falls back to the role's primary.

router.get("/plan/roles", async (req: Request, res: Response) => {
  const [{ data: roles, error: rErr }, { data: members, error: mErr }] = await Promise.all([
    db.from("smrtplan_roles").select("id, name_he, name_en, color").eq("org_id", req.org!.id).order("name_he", { ascending: true }),
    db.from("smrtplan_role_members").select("id, role_id, user_id, is_primary").eq("org_id", req.org!.id),
  ]);
  if (rErr) return res.status(500).json({ error: rErr.message });
  if (mErr) return res.status(500).json({ error: mErr.message });
  const byRole = new Map<string, Row[]>();
  for (const m of asRows(members)) {
    const rid = m.role_id as string;
    if (!byRole.has(rid)) byRole.set(rid, []);
    byRole.get(rid)!.push({ id: m.id, user_id: m.user_id, is_primary: m.is_primary });
  }
  res.json({ roles: asRows(roles).map((r) => ({ ...r, members: byRole.get(r.id as string) ?? [] })) });
});

router.post("/plan/roles", requireFull, async (req: Request, res: Response) => {
  const { name_he, name_en, color } = req.body ?? {};
  if (!name_he || typeof name_he !== "string") return res.status(400).json({ error: "name_he is required" });
  const { data, error } = await db
    .from("smrtplan_roles")
    .insert({ org_id: req.org!.id, name_he: name_he.trim(), name_en: name_en ?? null, color: color ?? null, created_by: req.user!.id })
    .select("id, name_he, name_en, color")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ role: { ...data, members: [] } });
});

router.patch("/plan/roles/:id", requireFull, async (req: Request, res: Response) => {
  const patch: Record<string, unknown> = {};
  for (const k of ["name_he", "name_en", "color"]) if (k in (req.body ?? {})) patch[k] = req.body[k];
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: "nothing to update" });
  const { data, error } = await db
    .from("smrtplan_roles").update(patch).eq("org_id", req.org!.id).eq("id", req.params.id)
    .select("id, name_he, name_en, color").single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ role: data });
});

router.delete("/plan/roles/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db.from("smrtplan_roles").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/plan/roles/:id/members", requireFull, async (req: Request, res: Response) => {
  const { user_id, is_primary } = req.body ?? {};
  if (!user_id) return res.status(400).json({ error: "user_id is required" });
  const { data: member } = await db.from("org_members").select("user_id").eq("org_id", req.org!.id).eq("user_id", user_id).maybeSingle();
  if (!member) return res.status(404).json({ error: "user is not a member of this org" });
  const { data: role } = await db.from("smrtplan_roles").select("id").eq("org_id", req.org!.id).eq("id", req.params.id).maybeSingle();
  if (!role) return res.status(404).json({ error: "role not found" });
  // Only one primary per role — clear the others first (partial-unique index).
  if (is_primary) {
    const { error: clearPrimaryErr } = await db.from("smrtplan_role_members").update({ is_primary: false }).eq("org_id", req.org!.id).eq("role_id", req.params.id);
    if (clearPrimaryErr) console.error("[smrtplan] clear prior primary role member failed:", clearPrimaryErr);
  }
  const { data, error } = await db
    .from("smrtplan_role_members")
    .insert({ org_id: req.org!.id, role_id: req.params.id, user_id, is_primary: !!is_primary })
    .select("id, role_id, user_id, is_primary")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ member: data });
});

router.patch("/plan/role-members/:id", requireFull, async (req: Request, res: Response) => {
  const { is_primary } = req.body ?? {};
  if (typeof is_primary !== "boolean") return res.status(400).json({ error: "is_primary (boolean) is required" });
  const { data: row } = await db.from("smrtplan_role_members").select("id, role_id").eq("org_id", req.org!.id).eq("id", req.params.id).maybeSingle();
  if (!row) return res.status(404).json({ error: "member not found" });
  if (is_primary) {
    const { error: clearPrimaryErr } = await db.from("smrtplan_role_members").update({ is_primary: false }).eq("org_id", req.org!.id).eq("role_id", row.role_id as string);
    if (clearPrimaryErr) console.error("[smrtplan] clear prior primary role member failed:", clearPrimaryErr);
  }
  const { data, error } = await db
    .from("smrtplan_role_members").update({ is_primary }).eq("org_id", req.org!.id).eq("id", req.params.id)
    .select("id, role_id, user_id, is_primary").single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ member: data });
});

router.delete("/plan/role-members/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db.from("smrtplan_role_members").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── templates ("marketing = 4 stages") ───────────────────────────────────────
// A template is an ordered set of task items (role + default duration) plus a
// dependency chain. Applying it spins up a new effort plan and generates the
// tasks, default assignees (role primary), and dependency edges in one shot.

const DAY = 86_400_000;

router.get("/plan/templates", async (req: Request, res: Response) => {
  const [{ data: tpls, error: tErr }, { data: items }, { data: deps }] = await Promise.all([
    db.from("smrtplan_templates").select("id, name_he, name_en, description").eq("org_id", req.org!.id).order("name_he", { ascending: true }),
    db.from("smrtplan_template_items").select("id, template_id, title_he, title_en, role_id, default_duration_days, sequence").eq("org_id", req.org!.id).order("sequence", { ascending: true }),
    db.from("smrtplan_template_deps").select("id, template_id, from_item_id, to_item_id, lag_days").eq("org_id", req.org!.id),
  ]);
  if (tErr) return res.status(500).json({ error: tErr.message });
  const itemsByTpl = new Map<string, Row[]>();
  for (const i of asRows(items)) {
    const k = i.template_id as string;
    if (!itemsByTpl.has(k)) itemsByTpl.set(k, []);
    itemsByTpl.get(k)!.push(i);
  }
  const depsByTpl = new Map<string, Row[]>();
  for (const d of asRows(deps)) {
    const k = d.template_id as string;
    if (!depsByTpl.has(k)) depsByTpl.set(k, []);
    depsByTpl.get(k)!.push(d);
  }
  res.json({
    templates: asRows(tpls).map((t) => ({
      ...t,
      items: itemsByTpl.get(t.id as string) ?? [],
      deps: depsByTpl.get(t.id as string) ?? [],
    })),
  });
});

router.post("/plan/templates", requireFull, async (req: Request, res: Response) => {
  const { name_he, name_en, description } = req.body ?? {};
  if (!name_he || typeof name_he !== "string") return res.status(400).json({ error: "name_he is required" });
  const { data, error } = await db
    .from("smrtplan_templates")
    .insert({ org_id: req.org!.id, name_he: name_he.trim(), name_en: name_en ?? null, description: description ?? null, created_by: req.user!.id })
    .select("id, name_he, name_en, description")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ template: { ...data, items: [], deps: [] } });
});

router.delete("/plan/templates/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db.from("smrtplan_templates").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/plan/templates/:id/items", requireFull, async (req: Request, res: Response) => {
  const { title_he, title_en, role_id, default_duration_days, sequence } = req.body ?? {};
  if (!title_he || typeof title_he !== "string") return res.status(400).json({ error: "title_he is required" });
  // Confirm the parent template belongs to this org before adding to it.
  const { data: tpl } = await db.from("smrtplan_templates").select("id").eq("org_id", req.org!.id).eq("id", req.params.id).maybeSingle();
  if (!tpl) return res.status(404).json({ error: "template not found" });
  const { validRoleId } = await roleDefaultAssignee(req.org!.id, (role_id as string | null) ?? null);
  const { data, error } = await db
    .from("smrtplan_template_items")
    .insert({
      org_id: req.org!.id,
      template_id: req.params.id,
      title_he: title_he.trim(),
      title_en: title_en ?? null,
      role_id: validRoleId,
      default_duration_days: default_duration_days != null && default_duration_days !== "" ? Number(default_duration_days) : null,
      sequence: typeof sequence === "number" ? sequence : 0,
    })
    .select("id, template_id, title_he, title_en, role_id, default_duration_days, sequence")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ item: data });
});

router.delete("/plan/template-items/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db.from("smrtplan_template_items").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post("/plan/template-deps", requireFull, async (req: Request, res: Response) => {
  const { template_id, from_item_id, to_item_id, lag_days } = req.body ?? {};
  if (!template_id || !from_item_id || !to_item_id) return res.status(400).json({ error: "template_id, from_item_id, to_item_id required" });
  if (from_item_id === to_item_id) return res.status(400).json({ error: "an item can't depend on itself" });
  const { data, error } = await db
    .from("smrtplan_template_deps")
    .insert({ org_id: req.org!.id, template_id, from_item_id, to_item_id, lag_days: Math.max(0, Math.round(Number(lag_days)) || 0) })
    .select("id, template_id, from_item_id, to_item_id, lag_days")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ dep: data });
});

router.delete("/plan/template-deps/:id", requireFull, async (req: Request, res: Response) => {
  const { error } = await db.from("smrtplan_template_deps").delete().eq("org_id", req.org!.id).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** Apply a template → create an effort plan and generate its tasks + deps. */
router.post("/plan/templates/:id/apply", requireFull, async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const { start_date, group_label } = req.body ?? {};
  const { data: tpl } = await db
    .from("smrtplan_templates").select("id, name_he, name_en").eq("org_id", orgId).eq("id", req.params.id).maybeSingle();
  if (!tpl) return res.status(404).json({ error: "template not found" });
  const { data: itemRows } = await db
    .from("smrtplan_template_items")
    .select("id, title_he, title_en, role_id, default_duration_days, sequence")
    .eq("org_id", orgId).eq("template_id", req.params.id).order("sequence", { ascending: true });
  const items = asRows(itemRows);
  if (items.length === 0) return res.status(400).json({ error: "template has no items" });
  const { data: depRows } = await db
    .from("smrtplan_template_deps").select("from_item_id, to_item_id, lag_days").eq("org_id", orgId).eq("template_id", req.params.id);
  const deps = asRows(depRows);

  // New effort plan (draft) — a rough horizon of ~1 working week per item so the
  // engine has a window to schedule backward into; the planner refines it.
  const start = start_date ? new Date(start_date as string) : new Date();
  const end = new Date(start.getTime() + Math.max(14, items.length * 7) * DAY);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const { data: plan, error: planErr } = await db
    .from("smrtplan_plans")
    .insert({
      org_id: orgId,
      created_by: req.user!.id,
      title_he: tpl.name_he,
      title_en: tpl.name_en ?? null,
      kind: "effort",
      status: "draft",
      group_label: group_label ?? null,
      start_date: iso(start),
      end_date: iso(end),
    })
    .select(PLAN_FIELDS)
    .single();
  if (planErr || !plan) return res.status(500).json({ error: planErr?.message ?? "failed to create plan" });
  const newPlanId = (plan as unknown as { id: string }).id;

  // Generate the tasks, staffing each by its role's primary.
  const taskByItem = new Map<string, string>();
  for (const it of items) {
    const { validRoleId, primary } = await roleDefaultAssignee(orgId, (it.role_id as string | null) ?? null);
    const dur = it.default_duration_days != null ? Number(it.default_duration_days) : null;
    const { data: task, error: taskErr } = await db
      .from("tasks")
      .insert({
        organization_id: orgId,
        user_id: req.user!.id,
        plan_id: newPlanId,
        title: (it.title_he as string),
        title_he: (it.title_he as string),
        status: "inbox",
        is_private: false,
        assignment_status: "accepted",
        duration_days: dur,
        duration_manual: dur != null,
        assigned_to_user_id: primary,
        role_id: validRoleId,
      })
      .select("id")
      .single();
    if (taskErr) return res.status(500).json({ error: taskErr.message });
    taskByItem.set(it.id as string, (task as unknown as { id: string }).id);
  }

  // Wire the dependency edges between the freshly created tasks.
  const edgeRows = deps
    .map((d) => ({
      org_id: orgId,
      from_type: "task",
      from_id: taskByItem.get(d.from_item_id as string),
      to_type: "task",
      to_id: taskByItem.get(d.to_item_id as string),
      lag_days: (d.lag_days as number | null) ?? 0,
    }))
    .filter((e) => e.from_id && e.to_id);
  if (edgeRows.length) {
    const { error: depErr } = await db.from("smrtplan_dependencies").insert(edgeRows);
    if (depErr) return res.status(500).json({ error: depErr.message });
  }

  await autoRecompute(orgId);
  res.status(201).json({ plan });
});

export default router;
