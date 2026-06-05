/**
 * smrtPlan engine — the logic that makes a table of plans a smart tool.
 *
 * Implements the five computations from smrtplan-engine.md:
 *   א  Backward scheduling   — latest_start / latest_finish from the deadline
 *   ב  Dependency release     — on task.completed, free the blocked successors
 *   ה  Critical path          — forward+backward pass, slack = 0 ⇒ critical
 *   (ג progress, ד health live in SQL views; see migration 20260604000400.)
 *
 * Hebrew calendar (§5.1a): every scheduled date skips Shabbat (Saturday),
 * yom tov and bein-hazmanim. A blocked target rolls BACK to the nearest valid
 * working day (we schedule backwards). Shabbat is computed here; yom tov /
 * bein-hazmanim come from smrtplan_blocked_days (global + per-org rows).
 *
 * The engine never invents content — it only writes the engine fields it owns
 * (duration_days, earliest_start, latest_start, latest_finish, is_critical) and
 * flips dependency.satisfied / matrix cells. Human edits always win: a task
 * with a manually set duration_days keeps it.
 */

import { db } from "../../db";

// ── working-day calendar ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
/** Org-wide fallback hours/day when an assignee has no capacity row (or none). */
const ORG_DEFAULT_HOURS_PER_DAY = 8;
/** "at risk" threshold — kept in sync with the smrtplan_task_health view. */
export const AT_RISK_DAYS = 3;

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/**
 * Load the blocked-day set for an org: global yom tov rows (org_id NULL) plus
 * that org's own rows. Shabbat is NOT stored — it is computed in isWorkingDay.
 */
export async function loadBlockedDates(orgId: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  const { data, error } = await db
    .from("smrtplan_blocked_days")
    .select("blocked_date, org_id")
    .or(`org_id.is.null,org_id.eq.${orgId}`);
  if (error) {
    console.error("[smrtplan.engine] loadBlockedDates:", error.message);
    return blocked;
  }
  for (const row of data ?? []) blocked.add(row.blocked_date as string);
  return blocked;
}

/** Load each org member's hours/day capacity (user_id → hours_per_day). */
export async function loadCapacity(orgId: string): Promise<Map<string, number>> {
  const cap = new Map<string, number>();
  const { data, error } = await db
    .from("smrtplan_capacity")
    .select("user_id, hours_per_day")
    .eq("org_id", orgId);
  if (error) {
    console.error("[smrtplan.engine] loadCapacity:", error.message);
    return cap;
  }
  for (const row of data ?? []) {
    const h = Number(row.hours_per_day);
    if (h > 0) cap.set(row.user_id as string, h);
  }
  return cap;
}

/** A working day = not Saturday and not in the blocked set. */
export function isWorkingDay(d: Date, blocked: Set<string>): boolean {
  if (d.getUTCDay() === 6) return false; // Shabbat
  return !blocked.has(toISO(d));
}

/** Roll a date backwards to the nearest valid working day (inclusive). */
export function rollBack(d: Date, blocked: Set<string>): Date {
  let cur = d;
  // Cap the walk so a pathological blocked range can never loop forever.
  for (let i = 0; i < 60 && !isWorkingDay(cur, blocked); i++) cur = addDays(cur, -1);
  return cur;
}

/** Roll a date forwards to the nearest valid working day (inclusive). */
export function rollForward(d: Date, blocked: Set<string>): Date {
  let cur = d;
  for (let i = 0; i < 60 && !isWorkingDay(cur, blocked); i++) cur = addDays(cur, 1);
  return cur;
}

/** Subtract n WORKING days from a date (the result is itself a working day). */
export function subtractWorkingDays(d: Date, n: number, blocked: Set<string>): Date {
  let cur = rollBack(d, blocked);
  let left = n;
  while (left > 0) {
    cur = addDays(cur, -1);
    if (isWorkingDay(cur, blocked)) left--;
  }
  return cur;
}

/** Add n WORKING days to a date (the result is itself a working day). */
export function addWorkingDays(d: Date, n: number, blocked: Set<string>): Date {
  let cur = rollForward(d, blocked);
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (isWorkingDay(cur, blocked)) left--;
  }
  return cur;
}

// ── scheduling graph types ───────────────────────────────────────────────────

interface EngineTask {
  id: string;
  plan_id: string | null;
  parent_task_id: string | null;
  duration_days: number | null;
  duration_manual: boolean;
  estimated_hours: number | null;
  assigned_to_user_id: string | null;
  due_date: string | null;
  status: string;
  created_at: string;
  // computed
  duration: number;
  durationEstimated: boolean;
  latest_finish?: Date;
  latest_start?: Date;
  earliest_start?: Date;
  earliest_finish?: Date;
  is_critical?: boolean;
}

// ── computation א + ה: backward scheduling + critical path ───────────────────

/**
 * Recompute the schedule for an ENTIRE ORG (all tasks across all its plans):
 * backward pass (latest_*), forward pass (earliest_*), critical-path flag, and
 * equal time-splitting for un-estimated sub-tasks. Writes the engine fields back
 * to `tasks`.
 *
 * Org-wide on purpose: dependencies cross plans (Maor's flagship case — the
 * video plan must FINISH so "design the characters" in the DESIGN plan can start
 * before 6/15). Each task's deadline horizon is ITS OWN plan's end_date, but a
 * cross-plan successor can pull that earlier through the dependency graph.
 */
export async function computeOrgSchedule(orgId: string): Promise<{
  org_id: string;
  scheduled: number;
  critical: number;
}> {
  const blocked = await loadBlockedDates(orgId);
  const capacity = await loadCapacity(orgId);

  const { data: planRows } = await db
    .from("smrtplan_plans")
    .select("id, start_date, end_date")
    .eq("org_id", orgId);
  if (!planRows || planRows.length === 0) return { org_id: orgId, scheduled: 0, critical: 0 };

  const planStartOf = new Map<string, Date | null>();
  const planEndOf = new Map<string, Date | null>();
  for (const p of planRows) {
    planStartOf.set(p.id as string, p.start_date ? parseISO(p.start_date as string) : null);
    planEndOf.set(p.id as string, p.end_date ? parseISO(p.end_date as string) : null);
  }

  const { data: taskRows, error: taskErr } = await db
    .from("tasks")
    .select("id, plan_id, parent_task_id, duration_days, duration_manual, estimated_hours, assigned_to_user_id, due_date, status, created_at")
    .eq("organization_id", orgId)
    .not("plan_id", "is", null);
  if (taskErr || !taskRows || taskRows.length === 0) {
    return { org_id: orgId, scheduled: 0, critical: 0 };
  }

  const tasks = new Map<string, EngineTask>();
  for (const r of taskRows) {
    tasks.set(r.id as string, {
      id: r.id as string,
      plan_id: (r.plan_id as string | null) ?? null,
      parent_task_id: (r.parent_task_id as string | null) ?? null,
      duration_days: (r.duration_days as number | null) ?? null,
      duration_manual: (r.duration_manual as boolean | null) ?? false,
      estimated_hours: (r.estimated_hours as number | null) ?? null,
      assigned_to_user_id: (r.assigned_to_user_id as string | null) ?? null,
      due_date: (r.due_date as string | null) ?? null,
      status: (r.status as string) ?? "inbox",
      created_at: (r.created_at as string) ?? new Date().toISOString(),
      duration: 0,
      durationEstimated: false,
    });
  }

  // Dependency edges: from (consumer/needs) → to (provider). For scheduling we
  // want precedence provider→consumer, i.e. successor(to)=from. All org task
  // edges, so cross-plan links are honoured.
  const ids = [...tasks.keys()];
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const id of ids) {
    successors.set(id, []);
    predecessors.set(id, []);
  }
  const { data: deps } = await db
    .from("smrtplan_dependencies")
    .select("from_id, to_id, from_type, to_type")
    .eq("org_id", orgId)
    .eq("from_type", "task")
    .eq("to_type", "task");
  for (const d of deps ?? []) {
    const consumer = d.from_id as string;
    const provider = d.to_id as string;
    if (!tasks.has(consumer) || !tasks.has(provider)) continue;
    successors.get(provider)!.push(consumer);
    predecessors.get(consumer)!.push(provider);
  }

  // Group sub-tasks by parent (for the equal-split below).
  const childrenByParent = new Map<string, EngineTask[]>();
  for (const t of tasks.values()) {
    if (!t.parent_task_id) continue;
    if (!childrenByParent.has(t.parent_task_id)) childrenByParent.set(t.parent_task_id, []);
    childrenByParent.get(t.parent_task_id)!.push(t);
  }

  // ── duration resolution — NO blanket default and NO plan-window split.
  //    Sub-tasks carry no private duration in planning (fix #2/#3); they get a
  //    staged date by splitting their parent's range below. ───────────────────
  for (const t of tasks.values()) {
    if (t.duration_manual && t.duration_days && t.duration_days > 0) {
      t.duration = t.duration_days; // human pin wins
    } else if (t.estimated_hours && t.estimated_hours > 0) {
      const hpd =
        (t.assigned_to_user_id && capacity.get(t.assigned_to_user_id)) || ORG_DEFAULT_HOURS_PER_DAY;
      t.duration = Math.max(1, Math.ceil(t.estimated_hours / hpd));
      t.durationEstimated = true; // derived
    } else {
      t.duration = 0; // unknown — no private duration
    }
  }

  // A task schedules backward from ITS OWN due_date (the row deadline), not the
  // plan's end_date. The plan end_date is only the gantt bar.
  const dueOf = (t: EngineTask): Date | null =>
    t.due_date ? rollBack(parseISO(t.due_date), blocked) : null;
  const floorOf = (t: EngineTask): Date => planStartOf.get(t.plan_id ?? "") ?? new Date();

  // Backward pass (reverse-topological): latest_finish = the earliest of the
  // row's own deadline and any successor's start constraint (external constraints
  // like a worker leaving therefore pull it earlier). No deadline ⇒ not scheduled.
  const order = topoOrder(ids, predecessors, successors);
  for (let i = order.length - 1; i >= 0; i--) {
    const t = tasks.get(order[i])!;
    let lf: Date | undefined = dueOf(t) ?? undefined;
    for (const sId of successors.get(t.id)!) {
      const s = tasks.get(sId)!;
      if (s.latest_start) {
        const before = subtractWorkingDays(s.latest_start, 1, blocked);
        if (!lf || before < lf) lf = before;
      }
    }
    if (lf) {
      t.latest_finish = lf;
      t.latest_start = t.duration > 0 ? subtractWorkingDays(lf, t.duration - 1, blocked) : lf;
    }
  }

  // Sub-task equal-split: divide the parent row's [start, deadline] range among
  // its children that have no private duration. The last child ends at the row
  // deadline; earlier ones are staged before it. Children keep duration_days NULL.
  for (const [parentId, children] of childrenByParent) {
    const parent = tasks.get(parentId);
    if (!parent) continue;
    const parentFinish = parent.latest_finish ?? dueOf(parent) ?? undefined;
    if (!parentFinish) continue;
    const splitKids = [...children]
      .filter((c) => c.duration === 0)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (splitKids.length === 0) continue;
    const start = parent.earliest_start ?? floorOf(parent);
    const per = Math.max(1, Math.floor(countWorkingDays(start, parentFinish, blocked) / splitKids.length));
    let cursor = rollBack(parentFinish, blocked);
    for (let i = splitKids.length - 1; i >= 0; i--) {
      const c = splitKids[i];
      c.latest_finish = cursor;
      c.latest_start = subtractWorkingDays(cursor, per - 1, blocked);
      cursor = subtractWorkingDays(c.latest_start, 1, blocked);
    }
  }

  // Forward pass (topological) — earliest_* for slack/critical.
  for (const id of order) {
    const t = tasks.get(id)!;
    let es = rollForward(floorOf(t), blocked);
    for (const pId of predecessors.get(t.id)!) {
      const p = tasks.get(pId)!;
      if (p.earliest_finish) {
        const after = addWorkingDays(p.earliest_finish, 1, blocked);
        if (after > es) es = after;
      }
    }
    t.earliest_start = rollForward(es, blocked);
    t.earliest_finish = addWorkingDays(t.earliest_start, Math.max(0, t.duration - 1), blocked);
  }

  // Critical path: slack = latest_start − earliest_start; slack ≤ 0 ⇒ critical.
  let criticalCount = 0;
  for (const t of tasks.values()) {
    const slackDays =
      t.latest_start && t.earliest_start
        ? Math.round((t.latest_start.getTime() - t.earliest_start.getTime()) / DAY_MS)
        : null;
    t.is_critical = slackDays !== null && slackDays <= 0;
    if (t.is_critical) criticalCount++;
  }

  // Persist.
  let scheduled = 0;
  for (const t of tasks.values()) {
    const { error: upErr } = await db
      .from("tasks")
      .update({
        duration_days: t.duration > 0 ? t.duration : null, // sub-tasks/unknown stay NULL
        earliest_start: t.earliest_start ? toISO(t.earliest_start) : null,
        latest_start: t.latest_start ? toISO(t.latest_start) : null,
        latest_finish: t.latest_finish ? toISO(t.latest_finish) : null,
        is_critical: t.is_critical ?? false,
      })
      .eq("id", t.id);
    if (!upErr) scheduled++;
  }

  return { org_id: orgId, scheduled, critical: criticalCount };
}

/** Per-plan entry point — resolves the org and recomputes org-wide (deps cross plans). */
export async function computePlanSchedule(planId: string): Promise<{
  org_id: string;
  scheduled: number;
  critical: number;
}> {
  const { data: plan } = await db
    .from("smrtplan_plans")
    .select("org_id")
    .eq("id", planId)
    .maybeSingle();
  if (!plan) return { org_id: "", scheduled: 0, critical: 0 };
  return computeOrgSchedule(plan.org_id as string);
}

function countWorkingDays(from: Date, to: Date, blocked: Set<string>): number {
  let n = 0;
  for (let cur = rollForward(from, blocked); cur <= to; cur = addDays(cur, 1)) {
    if (isWorkingDay(cur, blocked)) n++;
  }
  return Math.max(1, n);
}

/** Kahn topological sort; falls back to input order if a cycle is detected. */
function topoOrder(
  ids: string[],
  predecessors: Map<string, string[]>,
  successors: Map<string, string[]>,
): string[] {
  const indeg = new Map<string, number>();
  for (const id of ids) indeg.set(id, predecessors.get(id)!.length);
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const s of successors.get(id) ?? []) {
      indeg.set(s, (indeg.get(s) ?? 1) - 1);
      if ((indeg.get(s) ?? 0) === 0) queue.push(s);
    }
  }
  return out.length === ids.length ? out : ids;
}

// ── computation ב: dependency release on task.completed ──────────────────────

/**
 * A task just completed. Mark every dependency it satisfies, flip any matrix
 * cell that points at it to done (and open the next stage), and return the set
 * of consumer tasks that are now fully unblocked ("ready").
 */
export async function releaseDependents(
  orgId: string,
  completedTaskId: string,
): Promise<{ satisfied: number; unblocked: string[]; cellsClosed: number }> {
  const result = { satisfied: 0, unblocked: [] as string[], cellsClosed: 0 };

  // 1. Mark task→task dependencies where the completed task is the provider (to_id).
  const { data: edges } = await db
    .from("smrtplan_dependencies")
    .select("id, from_id")
    .eq("org_id", orgId)
    .eq("to_type", "task")
    .eq("to_id", completedTaskId)
    .eq("from_type", "task");

  for (const e of edges ?? []) {
    const { error } = await db
      .from("smrtplan_dependencies")
      .update({ satisfied: true })
      .eq("id", e.id as string);
    if (!error) result.satisfied++;
  }

  // 2. Which consumers are now fully satisfied? (all their inbound task deps satisfied)
  const consumerIds = [...new Set((edges ?? []).map((e) => e.from_id as string))];
  for (const cId of consumerIds) {
    const { data: remaining } = await db
      .from("smrtplan_dependencies")
      .select("id")
      .eq("org_id", orgId)
      .eq("from_type", "task")
      .eq("from_id", cId)
      .eq("to_type", "task")
      .eq("satisfied", false);
    if (!remaining || remaining.length === 0) result.unblocked.push(cId);
  }

  // 3. Matrix cells linked to this task → done; open the next stage's cell.
  const { data: cells } = await db
    .from("smrtplan_episode_stage_status")
    .select("id, episode_id, stage_id")
    .eq("org_id", orgId)
    .eq("task_id", completedTaskId);

  for (const cell of cells ?? []) {
    const { error } = await db
      .from("smrtplan_episode_stage_status")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", cell.id as string);
    if (error) continue;
    result.cellsClosed++;
    await openNextStage(orgId, cell.episode_id as string, cell.stage_id as string);
  }

  return result;
}

/** Move the next stage (by sequence) of an episode from todo → prog. */
async function openNextStage(orgId: string, episodeId: string, stageId: string): Promise<void> {
  const { data: stage } = await db
    .from("smrtplan_stages")
    .select("plan_id, sequence")
    .eq("id", stageId)
    .maybeSingle();
  if (!stage) return;

  const { data: next } = await db
    .from("smrtplan_stages")
    .select("id")
    .eq("plan_id", stage.plan_id as string)
    .gt("sequence", stage.sequence as number)
    .order("sequence", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!next) return;

  await db
    .from("smrtplan_episode_stage_status")
    .update({ status: "prog" })
    .eq("org_id", orgId)
    .eq("episode_id", episodeId)
    .eq("stage_id", next.id as string)
    .eq("status", "todo");
}

/** Recompute an org's whole schedule (daily refresh / on-demand). */
export async function refreshOrg(orgId: string): Promise<{ scheduled: number; critical: number }> {
  const r = await computeOrgSchedule(orgId);
  return { scheduled: r.scheduled, critical: r.critical };
}

/** Recompute every org that has plans (cron entry point). */
export async function refreshAll(): Promise<{ orgs: number; scheduled: number }> {
  const { data: orgs } = await db.from("smrtplan_plans").select("org_id");
  const uniqueOrgs = [...new Set((orgs ?? []).map((o) => o.org_id as string))];
  let scheduled = 0;
  for (const orgId of uniqueOrgs) {
    const r = await computeOrgSchedule(orgId);
    scheduled += r.scheduled;
  }
  return { orgs: uniqueOrgs.length, scheduled };
}
