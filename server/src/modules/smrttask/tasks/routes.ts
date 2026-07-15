/**
 * Task routes — base module (no AI required; every app gets these).
 * All routes require X-Org-Id and scope every query to the active org.
 *
 *   GET    /tasks                       list (with filters)
 *   GET    /tasks/:id                   single (with project + source_message joins)
 *   POST   /tasks                       create (manual task)
 *   PATCH  /tasks/reorder               batch write of today_position (desk drag)
 *   PATCH  /tasks/:id                   update fields
 *   DELETE /tasks/:id                   delete
 *   POST   /tasks/:id/complete          set status=archived, completed_at=now
 *   POST   /tasks/:id/snooze            set status=snoozed, snoozed_until=tomorrow 9am
 *   POST   /tasks/:id/seen              mark seen_at
 *   POST   /tasks/:id/updates           append entry to updates[] (manual note)
 *
 * Permission model (Phase 4 simplicity):
 *   any org member can read & write any task in their org.
 *   Tighter rules (creator-only edits, etc.) can be added later.
 */

import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../../../db";
import { enforceDebriefOnComplete } from "../../smrtplan/debrief";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { attachTaskAccess, requireFullTask } from "../lib/access";
import { emitEvent } from "../../../lib/platform";
import { simpleCall, parseJsonResponse } from "../../../anthropic";
import { nextOccurrence, isValidRecurrenceRule, normalizeRecurrence } from "./recurrence";

const router = Router();

// UTC instant of `hour`:00 local time in `tz` on `dateStr` (YYYY-MM-DD).
// Uses Intl.formatToParts (server-timezone independent, unlike the
// toLocaleString round-trip): read the wall time the guess maps to in `tz`,
// shift by the difference, and run a second pass to absorb a DST boundary
// crossed by the first adjustment.
function utcInstantForLocalHour(dateStr: string, hour: number, tz: string): Date {
  const target = Date.parse(`${dateStr}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const wallAsUtc = (instant: number): number => {
    const parts: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date(instant))) parts[p.type] = p.value;
    const hh = parts.hour === "24" ? "00" : parts.hour;
    return Date.parse(`${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}.000Z`);
  };
  let x = target - (wallAsUtc(target) - target);
  x = x - (wallAsUtc(x) - target);
  return new Date(x);
}

// Every task route requires auth + active org + smrtTask enabled for that org.
// attachTaskAccess resolves req.taskAccess ("full" | "lite") once for the whole
// router so list filtering + the per-:id ownership guard below can read it.
router.use(requireAuth, requireOrg, requireApp("smrttask"), attachTaskAccess);

// GET /tasks/access — the caller's smrtTask access level. Deliberately NOT
// behind requireFullTask: a lite (project-only) worker must be able to read
// their own level (the web onboarding gate and UI use it to hide the full-app
// surface). Registered before the /tasks/:id routes so "access" isn't an :id.
router.get("/tasks/access", (req: Request, res: Response) => {
  res.json({ access_level: req.taskAccess ?? "full" });
});

// Per-:id ownership guard for project-only workers. router.param fires only on
// routes that carry an `:id` param (so static routes like /tasks/day-plan are
// unaffected), and only does work for "lite" users — "full" users short-circuit
// with zero extra queries. A lite user may only act on a task assigned to them;
// anything else (incl. source-messages/:id, which reuses `:id`) returns 404.
router.param("id", (req: Request, res: Response, next: NextFunction, id: string) => {
  if (req.taskAccess !== "lite") return next();
  void (async () => {
    try {
      const { data, error } = await db
        .from("tasks")
        .select("assigned_to_user_id")
        .eq("organization_id", req.org!.id)
        .eq("id", id)
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.assigned_to_user_id !== req.user!.id) {
        return res.status(404).json({ error: "task not found" });
      }
      next();
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  })();
});

// ── fields whitelisted for PATCH ───────────────────────────────────────────
const UPDATABLE_FIELDS = new Set([
  "title", "title_he", "description", "priority", "status",
  "due_date", "due_time", "tags", "related_contact",
  "related_contact_email", "related_contact_phone",
  "project_id", "project_confidence", "assigned_to_user_id",
  "manually_verified", "source_link",
  // Scheduling: task kind, a precise reminder instant, and recurrence.
  "task_type", "reminder_at", "recurrence_rule", "recurrence_until",
  // Restore-from-dismissed clears these alongside status=inbox
  "dismissal_reason_code", "dismissal_reason_text",
  // JSON content fields — client sends the whole array after read-modify-write
  "ai_generated_content", "linked_drive_docs", "checklist", "task_materials",
  // Follow-up signals from ai-process (clearing when user reads the task)
  "has_unread_update", "completion_signal_detected", "completion_signal_reason",
  // Today work-plan position (null = הכל, 0+ = position in היום list)
  "today_position",
  // Cross-source duplicate suggestion — set by ai-process, cleared (→ null)
  // by the UI when the user dismisses the suggestion or merges the tasks.
  "suggested_duplicate_of",
  // Desk model: quick/medium/big tier + home/work execution context.
  "size", "context",
  // Daily method: the day a task is committed to (planned_for = today → "Today").
  "planned_for",
  // "Returned from snooze" chip — UI clears it (→ null) on first interaction.
  "woke_from_snooze_at",
  // "Waiting on Claude" chip — UI sets it (→ now) when a task is handed off to
  // claude.ai/code, and clears it (→ null) when the user marks Claude finished.
  "claude_waiting_since",
  // Undo of a snooze: the UI PATCHes { status: "inbox", snoozed_until: null }
  // to pull a task back out of snooze (the auto-snooze undo window, and the
  // "wake up now" action). snooze_count is intentionally NOT touched here.
  "snoozed_until",
]);

const STATUSES = ["inbox", "in_progress", "snoozed", "archived", "completed", "dismissed", "pending_completion"];
const SIZES = ["quick", "medium", "big"];
// rules_memory.rule_type CHECK constraint — must stay in sync with migration
// 20260424000001_backend_pipeline.sql. Any insert with a value outside this
// set fails at the DB level, so validate BEFORE inserting AI-parsed values.
const RULE_MEMORY_RULE_TYPES = new Set(["skip", "skip_spam", "action", "style", "bot", "preference", "financial"]);
const CONTEXTS = ["home", "work", "outside"];
const PRIORITIES = ["urgent", "high", "medium", "low"];
const TASK_TYPES = ["action", "project_suggestion", "brief_review", "followup", "meeting"];

/** Validate the shape of a checklist array coming from a client PATCH.
 *  Required: { id: string, title: string, done: boolean }.
 *  Optional but typed when present: created_at, completed_at (string|null),
 *  created_by ('user'|'ai'). */
function validateChecklist(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("checklist must be an array");
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") {
      throw new Error(`checklist[${i}] must be an object`);
    }
    if (typeof item.id !== "string" || !item.id) {
      throw new Error(`checklist[${i}].id must be a non-empty string`);
    }
    if (typeof item.title !== "string") {
      throw new Error(`checklist[${i}].title must be a string`);
    }
    if (typeof item.done !== "boolean") {
      throw new Error(`checklist[${i}].done must be a boolean`);
    }
    if (item.created_at !== undefined && typeof item.created_at !== "string") {
      throw new Error(`checklist[${i}].created_at must be a string when present`);
    }
    if (item.completed_at !== undefined && item.completed_at !== null && typeof item.completed_at !== "string") {
      throw new Error(`checklist[${i}].completed_at must be string or null`);
    }
    if (item.created_by !== undefined && item.created_by !== "user" && item.created_by !== "ai") {
      throw new Error(`checklist[${i}].created_by must be 'user' or 'ai'`);
    }
  }
}

/** Validate task_materials shape coming from a client PATCH.
 *  Each item must declare type + id + title. type-specific optional fields
 *  are validated lightly (string/number where present). Hard cap on the
 *  serialized size to keep the row from ballooning. */
const MATERIAL_TYPES = new Set(["note", "link", "file", "contact"]);
const MAX_MATERIALS_ITEMS = 200;
const MAX_MATERIALS_BYTES = 64 * 1024;

function validateTaskMaterials(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("task_materials must be an array");
  }
  if (value.length > MAX_MATERIALS_ITEMS) {
    throw new Error(`task_materials exceeds ${MAX_MATERIALS_ITEMS} items`);
  }
  if (JSON.stringify(value).length > MAX_MATERIALS_BYTES) {
    throw new Error("task_materials exceeds size limit");
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") {
      throw new Error(`task_materials[${i}] must be an object`);
    }
    if (typeof item.id !== "string" || !item.id) {
      throw new Error(`task_materials[${i}].id must be a non-empty string`);
    }
    if (typeof item.type !== "string" || !MATERIAL_TYPES.has(item.type)) {
      throw new Error(`task_materials[${i}].type must be one of note|link|file|contact`);
    }
    if (typeof item.title !== "string") {
      throw new Error(`task_materials[${i}].title must be a string`);
    }
    for (const k of ["content", "url", "file_path", "file_mime", "contact_name", "contact_email", "contact_phone", "created_at", "created_by"] as const) {
      if (item[k] !== undefined && typeof item[k] !== "string") {
        throw new Error(`task_materials[${i}].${k} must be a string when present`);
      }
    }
    if (item.file_size !== undefined && typeof item.file_size !== "number") {
      throw new Error(`task_materials[${i}].file_size must be a number when present`);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function pickUpdates(body: Record<string, unknown>) {
  const updates: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (UPDATABLE_FIELDS.has(k)) updates[k] = body[k];
  }
  // Light validation
  if (updates.status && !STATUSES.includes(updates.status as string)) {
    throw new Error(`invalid status: ${updates.status}`);
  }
  if (updates.priority && !PRIORITIES.includes(updates.priority as string)) {
    throw new Error(`invalid priority: ${updates.priority}`);
  }
  if (updates.task_type && !TASK_TYPES.includes(updates.task_type as string)) {
    throw new Error(`invalid task_type: ${updates.task_type}`);
  }
  if (updates.size && !SIZES.includes(updates.size as string)) {
    throw new Error(`invalid size: ${updates.size}`);
  }
  if (updates.context !== undefined && updates.context !== null
      && !CONTEXTS.includes(updates.context as string)) {
    throw new Error(`invalid context: ${updates.context}`);
  }
  if (updates.recurrence_rule !== undefined && updates.recurrence_rule !== null
      && !isValidRecurrenceRule(updates.recurrence_rule)) {
    throw new Error(`invalid recurrence_rule: ${updates.recurrence_rule}`);
  }
  if (updates.checklist !== undefined) {
    validateChecklist(updates.checklist);
  }
  if (updates.task_materials !== undefined) {
    validateTaskMaterials(updates.task_materials);
  }
  return updates;
}

// ── routes ─────────────────────────────────────────────────────────────────

/**
 * Apply common task filters from query params.
 * Used by both /tasks (list) and /tasks/count.
 *   status        — single status or comma-separated
 *   verified      — "true" | "false"  (manually_verified)
 *   project_id    — uuid
 *   assigned_to   — uuid
 *   has_source    — "true" → source_message_id IS NOT NULL  (AI-sourced)
 *                  "false" → source_message_id IS NULL       (manually created)
 *   task_type     — single type or comma-separated  ("action","project_suggestion",...)
 */
function applyTaskFilters<T extends { eq: (k: string, v: unknown) => T; in: (k: string, v: unknown[]) => T; not: (k: string, op: string, v: unknown) => T; is: (k: string, v: unknown) => T }>(
  q: T, query: Request["query"], userId?: string,
): T {
  const { status, verified, project_id, assigned_to, has_source, task_type, today, mine, size, context } = query;
  // mine=true → personal scope: rows the user owns (user_id). Used by the
  // suggestions inbox, which is per-user rather than org-wide.
  if (mine === "true" && userId) q = q.eq("user_id", userId);
  if (typeof size === "string" && SIZES.includes(size)) q = q.eq("size", size);
  if (context === "home" || context === "work" || context === "outside") q = q.eq("context", context);
  if (typeof status === "string") {
    const list = status.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 1) q = q.eq("status", list[0]);
    else if (list.length > 1) q = q.in("status", list);
  }
  if (typeof task_type === "string") {
    const list = task_type.split(",").map((s) => s.trim()).filter(Boolean);
    if (list.length === 1) q = q.eq("task_type", list[0]);
    else if (list.length > 1) q = q.in("task_type", list);
  }
  if (verified === "true")  q = q.eq("manually_verified", true);
  if (verified === "false") q = q.eq("manually_verified", false);
  if (typeof project_id === "string")  q = q.eq("project_id", project_id);
  if (typeof assigned_to === "string") q = q.eq("assigned_to_user_id", assigned_to);
  if (has_source === "true")  q = q.not("source_message_id", "is", null);
  if (has_source === "false") q = q.is("source_message_id", null);
  // today=true → today_position IS NOT NULL (tasks in the Today work-plan)
  // today=false → today_position IS NULL
  if (today === "true")  q = q.not("today_position", "is", null);
  if (today === "false") q = q.is("today_position", null);
  return q;
}

/** GET /tasks?status=inbox&verified=true&project_id=...&assigned_to=...&has_source=true&task_type=action&limit=50 */
router.get("/tasks", async (req: Request, res: Response) => {
  const { limit } = req.query;

  let q = db
    .from("tasks")
    .select("*, source_messages(id, source_type, source_id, source_url, serial_display), projects(id, name, name_he, color, parent_id), suggested_duplicate:tasks!suggested_duplicate_of(id, title, title_he, serial_display)")
    .eq("organization_id", req.org!.id);

  q = applyTaskFilters(q, req.query, req.user!.id);
  // Project-only workers only ever see tasks assigned to them (from a plan or by
  // another user/manager) — enforced here, not left to an optional filter.
  if (req.taskAccess === "lite") q = q.eq("assigned_to_user_id", req.user!.id);
  // Hide tasks of draft (not-yet-approved) smrtPlan plans. Ordinary tasks have a
  // null plan_id, so the null branch keeps them (a bare not-in would drop nulls).
  const { data: draftPlans } = await db.from("smrtplan_plans").select("id").eq("org_id", req.org!.id).eq("status", "draft");
  const draftIds = (draftPlans ?? []).map((p) => p.id as string);
  if (draftIds.length) q = q.or(`plan_id.is.null,plan_id.not.in.(${draftIds.join(",")})`);
  q = q.order("created_at", { ascending: false });
  // 1000 cap: the suggestions inbox shows EVERY pending suggestion in one list.
  const n = Math.min(parseInt((limit as string) ?? "50", 10) || 50, 1000);
  q = q.limit(n);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ tasks: data ?? [] });
});

/** GET /tasks/count — same filters as /tasks, returns just `{ count: number }` */
router.get("/tasks/count", async (req: Request, res: Response) => {
  let q = db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", req.org!.id);
  q = applyTaskFilters(q, req.query, req.user!.id);
  if (req.taskAccess === "lite") q = q.eq("assigned_to_user_id", req.user!.id);
  const { data: draftPlans } = await db.from("smrtplan_plans").select("id").eq("org_id", req.org!.id).eq("status", "draft");
  const draftIds = (draftPlans ?? []).map((p) => p.id as string);
  if (draftIds.length) q = q.or(`plan_id.is.null,plan_id.not.in.(${draftIds.join(",")})`);

  const { count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count ?? 0 });
});

// ── day-plan (מהיר·3·1 day-tool) ────────────────────────────────────────────
// A daily_plans row records the day the user "built": the medium/big picks +
// the quick load. The nightly rollover closes it out with the completion
// snapshot (see 20260712130000_daily_plans.sql). Registered BEFORE GET/PATCH
// /tasks/:id so "day-plan" isn't captured as an :id.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /tasks/day-plan?date=YYYY-MM-DD — that day's committed plan (or null). */
router.get("/tasks/day-plan", async (req: Request, res: Response) => {
  const date = String(req.query.date ?? "");
  if (!ISO_DATE.test(date)) {
    return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  }
  const { data, error } = await db
    .from("daily_plans")
    .select("*")
    .eq("user_id", req.user!.id)
    .eq("plan_date", date)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ plan: data ?? null });
});

/** POST /tasks/day-plan — upsert today's committed picks.
 *  Body: { plan_date: "YYYY-MM-DD", picked_task_ids: string[], quick_total: number }.
 *  Idempotent per (user_id, plan_date): rebuilding the day overwrites the picks
 *  and quick_total but never the completion counts (only the rollover writes those). */
router.post("/tasks/day-plan", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const planDate = String(body.plan_date ?? "");
  if (!ISO_DATE.test(planDate)) {
    return res.status(400).json({ error: "plan_date must be YYYY-MM-DD" });
  }
  const picked = body.picked_task_ids;
  if (!Array.isArray(picked) || picked.some((id) => typeof id !== "string" || !id)) {
    return res.status(400).json({ error: "picked_task_ids must be an array of task ids" });
  }
  if (picked.length > 100) {
    return res.status(400).json({ error: "picked_task_ids is limited to 100 entries" });
  }
  const quickTotal = body.quick_total;
  if (typeof quickTotal !== "number" || !Number.isInteger(quickTotal) || quickTotal < 0) {
    return res.status(400).json({ error: "quick_total must be a non-negative integer" });
  }

  const { data, error } = await db
    .from("daily_plans")
    .upsert(
      {
        user_id: req.user!.id,
        org_id: req.org!.id,
        plan_date: planDate,
        picked_task_ids: picked,
        quick_total: quickTotal,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,plan_date" },
    )
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ plan: data });
});

// ── work-clock (workclock day-tool) ─────────────────────────────────────────
// A work_sessions row logs the workday: bounds, worked/paused seconds, per-size
// breakdown, escalation counts, and how it closed (see
// 20260714000000_work_sessions.sql). The client drives the live clock off a
// monotonic started_at and heartbeats here. Registered BEFORE GET/PATCH
// /tasks/:id so "work-clock" isn't captured as an :id.

/** Coerce a body value to a non-negative integer, or undefined if absent/invalid. */
function nonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

/** GET /tasks/work-clock/today?date=YYYY-MM-DD — that day's session (or null). */
router.get("/tasks/work-clock/today", async (req: Request, res: Response) => {
  const date = String(req.query.date ?? "");
  if (!ISO_DATE.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const { data, error } = await db
    .from("work_sessions")
    .select("*")
    .eq("user_id", req.user!.id)
    .eq("work_date", date)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ session: data ?? null });
});

/** POST /tasks/work-clock/start — start or resume today's session.
 *  Body: { work_date: "YYYY-MM-DD" }. Idempotent per (user_id, work_date):
 *  resuming a closed day reopens the same row (closed_reason→open, ended_at→null)
 *  and keeps the accumulated seconds. */
router.post("/tasks/work-clock/start", async (req: Request, res: Response) => {
  const workDate = String((req.body ?? {}).work_date ?? "");
  if (!ISO_DATE.test(workDate)) return res.status(400).json({ error: "work_date must be YYYY-MM-DD" });
  const { data, error } = await db
    .from("work_sessions")
    .upsert(
      {
        user_id: req.user!.id,
        org_id: req.org!.id,
        work_date: workDate,
        closed_reason: "open",
        ended_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,work_date" },
    )
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ session: data });
});

/** PATCH /tasks/work-clock — heartbeat: persist the accumulated counters.
 *  Body: { work_date, worked_seconds?, paused_seconds?, quick_seconds?,
 *  medium_seconds?, big_seconds?, alerts_soft?, alerts_popup?, alerts_block?,
 *  ritual_completed? }. Only present, valid fields are written. */
router.patch("/tasks/work-clock", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const workDate = String(body.work_date ?? "");
  if (!ISO_DATE.test(workDate)) return res.status(400).json({ error: "work_date must be YYYY-MM-DD" });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of [
    "worked_seconds", "paused_seconds", "quick_seconds", "medium_seconds",
    "big_seconds", "alerts_soft", "alerts_popup", "alerts_block",
  ]) {
    const n = nonNegInt(body[k]);
    if (n !== undefined) patch[k] = n;
  }
  if (typeof body.ritual_completed === "boolean") patch.ritual_completed = body.ritual_completed;

  const { data, error } = await db
    .from("work_sessions")
    .upsert(
      { user_id: req.user!.id, org_id: req.org!.id, work_date: workDate, ...patch },
      { onConflict: "user_id,work_date" },
    )
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ session: data });
});

/** POST /tasks/work-clock/stop — close the day.
 *  Body: { work_date, reason?: 'manual'|'auto'|'extended', worked_seconds?,
 *  paused_seconds? }. */
router.post("/tasks/work-clock/stop", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const workDate = String(body.work_date ?? "");
  if (!ISO_DATE.test(workDate)) return res.status(400).json({ error: "work_date must be YYYY-MM-DD" });
  const reason = ["manual", "auto", "extended"].includes(body.reason) ? body.reason : "manual";

  const patch: Record<string, unknown> = {
    user_id: req.user!.id,
    org_id: req.org!.id,
    work_date: workDate,
    ended_at: new Date().toISOString(),
    closed_reason: reason,
    updated_at: new Date().toISOString(),
  };
  const worked = nonNegInt(body.worked_seconds);
  const paused = nonNegInt(body.paused_seconds);
  if (worked !== undefined) patch.worked_seconds = worked;
  if (paused !== undefined) patch.paused_seconds = paused;

  const { data, error } = await db
    .from("work_sessions")
    .upsert(patch, { onConflict: "user_id,work_date" })
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ session: data });
});

/** POST /tasks/work-clock/span — record one closed active-task span (workclock
 *  phase 4). Body: { work_date, task_id?, size, seconds, started_at?, ended_at? }. */
router.post("/tasks/work-clock/span", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const workDate = String(body.work_date ?? "");
  if (!ISO_DATE.test(workDate)) return res.status(400).json({ error: "work_date must be YYYY-MM-DD" });
  if (!["quick", "medium", "big"].includes(body.size)) return res.status(400).json({ error: "size must be quick|medium|big" });
  const seconds = nonNegInt(body.seconds);
  if (seconds === undefined) return res.status(400).json({ error: "seconds must be a non-negative integer" });
  if (seconds === 0) return res.json({ ok: true }); // nothing to log

  const { error } = await db.from("work_task_spans").insert({
    user_id: req.user!.id,
    org_id: req.org!.id,
    work_date: workDate,
    task_id: typeof body.task_id === "string" && body.task_id ? body.task_id : null,
    size: body.size,
    seconds,
    started_at: typeof body.started_at === "string" ? body.started_at : null,
    ended_at: typeof body.ended_at === "string" ? body.ended_at : null,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** GET /tasks/work-clock/insights — learning summary over the last N days:
 *  average worked day length, per-size averages, day count. */
router.get("/tasks/work-clock/insights", async (req: Request, res: Response) => {
  const days = Math.min(90, Math.max(1, parseInt(String(req.query.days ?? "30"), 10) || 30));
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

  const { data: sessions, error: sErr } = await db
    .from("work_sessions")
    .select("worked_seconds, quick_seconds, medium_seconds, big_seconds, alerts_soft, alerts_popup, alerts_block, closed_reason")
    .eq("user_id", req.user!.id)
    .gte("work_date", since);
  if (sErr) return res.status(500).json({ error: sErr.message });

  const rows = sessions ?? [];
  const closed = rows.filter((r) => r.closed_reason !== "open");
  const n = closed.length || 1;
  const sum = (f: (r: typeof rows[number]) => number) => closed.reduce((a, r) => a + (f(r) || 0), 0);

  res.json({
    days,
    sessions: closed.length,
    avg_worked_seconds: Math.round(sum((r) => r.worked_seconds) / n),
    total_worked_seconds: sum((r) => r.worked_seconds),
    avg_quick_seconds: Math.round(sum((r) => r.quick_seconds) / n),
    avg_medium_seconds: Math.round(sum((r) => r.medium_seconds) / n),
    avg_big_seconds: Math.round(sum((r) => r.big_seconds) / n),
    alerts: { soft: sum((r) => r.alerts_soft), popup: sum((r) => r.alerts_popup), block: sum((r) => r.alerts_block) },
  });
});

/** GET /tasks/:id */
router.get("/tasks/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("tasks")
    .select("*, source_messages(id, source_type, source_id, source_url, serial_display), projects(id, name, name_he, color, parent_id), suggested_duplicate:tasks!suggested_duplicate_of(id, title, title_he, serial_display)")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "task not found" });
  res.json({ task: data });
});

/** POST /tasks — create manual task */
router.post("/tasks", requireFullTask, async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.title || typeof body.title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  let updates: Record<string, unknown>;
  try { updates = pickUpdates(body); }
  catch (e) { return res.status(400).json({ error: (e as Error).message }); }

  // COUNT ("ends after N occurrences") is resolved into a concrete
  // recurrence_until here, then stripped from the stored rule — the spawn
  // engine never tracks COUNT. Anchor on the task's start (due_date) when set;
  // otherwise on today, so "ends after N" with no due date still terminates
  // instead of recurring forever (the spawn loop bases on due_date ?? today).
  if (typeof updates.recurrence_rule === "string") {
    const start = (typeof updates.due_date === "string" ? updates.due_date : undefined)
      ?? new Date().toISOString().slice(0, 10);
    const normalized = normalizeRecurrence(updates.recurrence_rule, start);
    if (normalized) {
      updates.recurrence_rule = normalized.rule;
      if (normalized.until && updates.recurrence_until == null) {
        updates.recurrence_until = normalized.until;
      }
    }
  }

  // A recurring task created for a FUTURE date must not sit in the active list
  // weeks before its date (user rule 2026-06-11: "משימות חוזרות צריכות להופיע
  // רק בתאריך שהן חזרו"). Mirror the complete-spawn path: snooze it until 07:00
  // local on its due_date — reminders-check wakes it into the inbox that morning.
  // Skip when the caller set an explicit status/snooze itself.
  if (typeof updates.recurrence_rule === "string"
      && typeof updates.due_date === "string"
      && updates.status === undefined && updates.snoozed_until === undefined) {
    const today = new Date().toISOString().slice(0, 10);
    if (updates.due_date > today) {
      const { data: us } = await db
        .from("user_settings").select("timezone").eq("user_id", req.user!.id).maybeSingle();
      const tz = (us?.timezone as string | null) || "Asia/Jerusalem";
      updates.status = "snoozed";
      updates.snoozed_until = utcInstantForLocalHour(updates.due_date, 7, tz).toISOString();
    }
  }

  const payload = {
    user_id: req.user!.id,
    organization_id: req.org!.id,
    task_type: "action",
    priority: "medium",
    status: "inbox",
    manually_verified: true,        // user-created → already trusted
    ...updates,
  };

  const { data, error } = await db
    .from("tasks")
    .insert(payload)
    .select("*, source_messages(id, source_type, source_id, source_url, serial_display), projects(id, name, name_he, color, parent_id)")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await emitEvent(req.org!.id, "smrttask", "task.created", "task", data.id, {
    title: data.title,
    priority: data.priority,
  });

  res.status(201).json({ task: data });
});

/** PATCH /tasks/reorder — batch write of a desk column's order.
 *  Body: { items: [{ id, today_position, size? }] }. One HTTP round-trip for
 *  the whole column after a drag; previously the UI PATCHed each row
 *  individually (15 rows = 15 requests). `size` is only sent for a row
 *  crossing between desk columns (quick ↔ regular).
 *  NOTE: registered BEFORE PATCH /tasks/:id — Express matches routes in
 *  registration order, so this must come first or "reorder" is captured
 *  as an :id. */
router.patch("/tasks/reorder", requireFullTask, async (req: Request, res: Response) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items must be a non-empty array" });
  }
  if (items.length > 100) {
    return res.status(400).json({ error: "items is limited to 100 entries" });
  }
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) {
      return res.status(400).json({ error: "each item requires a string id" });
    }
    if (typeof item.today_position !== "number" || !Number.isFinite(item.today_position)) {
      return res.status(400).json({ error: "each item requires a finite today_position" });
    }
    if (item.size !== undefined && !SIZES.includes(item.size)) {
      return res.status(400).json({ error: `size must be one of: ${SIZES.join(", ")}` });
    }
  }

  const now = new Date().toISOString();
  const results = await Promise.all(
    (items as { id: string; today_position: number; size?: string }[]).map(async (item) => {
      // Mirror PATCH /tasks/:id semantics: a position-only patch is NOT the
      // user touching the task — it must not reset the aging clock or clear
      // the snooze-return chip. A size change (row crossing desk columns) IS
      // a user interaction, exactly like the per-row PATCH's positionOnly rule.
      const updates: Record<string, unknown> = {
        today_position: item.today_position,
        updated_at: now,
      };
      if (item.size !== undefined) {
        updates.size = item.size;
        updates.last_interaction_at = now;
        updates.woke_from_snooze_at = null;
      }
      const { data, error } = await db
        .from("tasks")
        .update(updates)
        .eq("organization_id", req.org!.id)
        .eq("id", item.id)
        .select("id, updated_at")
        .maybeSingle();
      if (error) console.error("[tasks reorder] update failed for", item.id, "—", error.message);
      // data === null with no error → task not found in this org: also a failure.
      return { id: item.id, task: data ?? null, failed: !!error || !data };
    }),
  );

  const failedIds = results.filter((r) => r.failed).map((r) => r.id);
  if (failedIds.length > 0) {
    return res.status(500).json({ error: "some tasks failed to reorder", failed_ids: failedIds });
  }
  res.json({ tasks: results.map((r) => r.task) });
});

/** PATCH /tasks/:id */
router.patch("/tasks/:id", async (req: Request, res: Response) => {
  let updates: Record<string, unknown>;
  try { updates = pickUpdates(req.body ?? {}); }
  catch (e) { return res.status(400).json({ error: (e as Error).message }); }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  // Assigning a task to someone is a manager-only action (org owner/admin).
  // A non-manager PATCH may not touch assigned_to_user_id.
  if ("assigned_to_user_id" in updates) {
    const role = req.member!.role;
    if (role !== "owner" && role !== "admin") {
      return res.status(403).json({ error: "only an org manager can assign tasks" });
    }
  }

  // An unverified→verified flip is "the suggestion was approved" — read the
  // prior value first so we log the TRANSITION only (a repeated verified:true
  // patch, e.g. a double-click, must not write duplicate audit rows).
  let wasVerified: boolean | null = null;
  if (updates.manually_verified === true) {
    const { data: prior } = await db
      .from("tasks")
      .select("manually_verified")
      .eq("organization_id", req.org!.id)
      .eq("id", req.params.id)
      .maybeSingle();
    wasVerified = prior ? prior.manually_verified === true : null;
  }

  // Recurrence edits go through the same COUNT → recurrence_until resolution as
  // create (POST). PATCH previously skipped this, so an edited "ends after N
  // occurrences" rule stored a bare COUNT the lazy spawn engine ignores — the
  // series never terminated. Anchor on the incoming due_date when the same PATCH
  // sets one; otherwise read the task's current due_date so the Nth occurrence is
  // computed from the real start. Falls back to today when the task has none.
  if (typeof updates.recurrence_rule === "string") {
    let start = typeof updates.due_date === "string" ? updates.due_date : undefined;
    if (!start) {
      const { data: cur } = await db
        .from("tasks")
        .select("due_date")
        .eq("organization_id", req.org!.id)
        .eq("id", req.params.id)
        .maybeSingle();
      start = (cur?.due_date as string | null) ?? undefined;
    }
    const normalized = normalizeRecurrence(
      updates.recurrence_rule,
      start ?? new Date().toISOString().slice(0, 10),
    );
    if (normalized) {
      updates.recurrence_rule = normalized.rule;
      // Match POST: apply the computed until whenever the caller didn't set an
      // explicit one. The client sends recurrence_until:null for COUNT ("ends
      // after N") rules, so `== null` (not `=== undefined`) is required — else
      // COUNT is stripped from the rule but never converted to an end date and
      // the series never terminates.
      if (normalized.until && updates.recurrence_until == null) {
        updates.recurrence_until = normalized.until;
      }
    }
  }

  // Track status_changed_at
  if (updates.status) updates.status_changed_at = new Date().toISOString();
  // A position-only patch (drag-reorder writes today_position to every row of
  // a column) is NOT the user touching those tasks — it must not reset the
  // aging clock or clear the snooze-return chip.
  const positionOnly = Object.keys(updates).every((k) => k === "today_position");
  updates.updated_at = new Date().toISOString();
  if (!positionOnly) {
    // Every user-driven edit counts as an interaction (aging clock) and clears
    // the "returned from snooze" chip — unless the patch sets the chip itself.
    updates.last_interaction_at = updates.updated_at;
    if (!("woke_from_snooze_at" in updates)) updates.woke_from_snooze_at = null;
  }

  // A generic status-patch into a COMPLETION status is a completion too — enforce
  // the research-task debrief here as well, so this path can't bypass the gate
  // (acceptance #1). Completion = completed/archived (smrtTask "completes" to
  // archived); dismissing/discarding a research task does NOT require a debrief.
  if (typeof updates.status === "string" && (updates.status === "completed" || updates.status === "archived")) {
    const block = await enforceDebriefOnComplete(req.org!.id, req.params.id, req.user!.id, req.body ?? {});
    if (block) return res.status(block.status).json({ error: block.error });
  }

  const { data, error } = await db
    .from("tasks")
    .update(updates)
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("*, source_messages(id, source_type, source_id, source_url, serial_display), projects(id, name, name_he, color, parent_id)")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "task not found in this org" });

  // Forensics: record the approve transition — see the June-2026 ספרלין case
  // ("how did this suggestion become a task?").
  if (updates.manually_verified === true && wasVerified === false) {
    const { error: actErr } = await db.from("task_activities").insert({
      user_id: req.user!.id,
      task_id: req.params.id,
      activity_type: "approved",
      new_value: "verified",
      note: "approved via PATCH (suggestion → task)",
      actor: "user",
    });
    if (actErr) console.error("[tasks PATCH] approve activity log failed:", actErr.message);
  }

  res.json({ task: data });
});

/** DELETE /tasks/:id */
router.delete("/tasks/:id", requireFullTask, async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("tasks")
    .delete({ count: "exact" })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "task not found in this org" });
  res.json({ ok: true });
});

/** POST /tasks/:id/complete */
router.post("/tasks/:id/complete", async (req: Request, res: Response) => {
  const now = new Date().toISOString();
  // Research tasks (requires_debrief) can't be closed via the desk path either —
  // enforce the debrief before the status write (acceptance #1: even via direct
  // API). No-op for ordinary tasks (requires_debrief defaults false).
  const block = await enforceDebriefOnComplete(req.org!.id, req.params.id, req.user!.id, req.body ?? {});
  if (block) return res.status(block.status).json({ error: block.error });
  const { data, error } = await db
    .from("tasks")
    .update({ status: "archived", completed_at: now, status_changed_at: now })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, status, completed_at, recurrence_rule, recurrence_until, recurrence_parent_id, due_date, due_time, reminder_at, title, title_he, description, priority, task_type, size, context, project_id, tags, checklist")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "task not found in this org" });

  // Forensics: completion used to leave NO trail at all, which made the
  // June-2026 "suggestions vanished" incident unattributable (two unverified
  // suggestions were completed-archived and nothing recorded who or from
  // where). Record the actor identity on every completion.
  const { error: actErr } = await db.from("task_activities").insert({
    user_id: req.user!.id,
    task_id: data.id,
    activity_type: "completed",
    new_value: "archived",
    note: `completed via POST /complete by ${req.user!.email ?? req.user!.id}`,
    actor: "user",
  });
  if (actErr) console.error("[tasks complete] activity log failed:", actErr.message);

  await emitEvent(req.org!.id, "smrttask", "task.completed", "task", data.id, {
    completed_at: data.completed_at,
  });

  // Recurring task → spawn the next instance. We anchor the next date on this
  // instance's due_date (falling back to today), so a daily task completed late
  // still advances by one day from its scheduled date.
  let nextTask = null;
  if (data.recurrence_rule) {
    const today = now.slice(0, 10);
    const base = (data.due_date as string | null) ?? today;
    // Floor on today so a task completed late still advances to a future date.
    const next = nextOccurrence(data.recurrence_rule as string, base, today);
    const stop = data.recurrence_until as string | null;
    if (next && (!stop || next <= stop)) {
      // Carry the reminder offset forward: keep the same gap between due_date
      // and reminder_at on the new instance (e.g. "1h before").
      let nextReminder: string | null = null;
      if (data.reminder_at && data.due_date) {
        const offsetMs = new Date(data.reminder_at as string).getTime() - new Date(`${data.due_date}T00:00:00.000Z`).getTime();
        nextReminder = new Date(new Date(`${next}T00:00:00.000Z`).getTime() + offsetMs).toISOString();
      }
      // Reset checklist completion on the fresh instance.
      const checklist = Array.isArray(data.checklist)
        ? (data.checklist as Record<string, unknown>[]).map((c) => ({ ...c, done: false, completed_at: null }))
        : data.checklist;
      // A recurring occurrence must NOT sit in the inbox weeks before its date
      // (user rule 2026-06-11: "משימות חוזרות צריכות להופיע רק בתאריך שהן
      // חזרו"). Spawn future occurrences snoozed until 07:00 local on their
      // due date — reminders-check wakes them into the inbox that morning
      // with the "returned from snooze" chip. A same-day occurrence goes
      // straight to the inbox as before.
      let spawnStatus = "inbox";
      let spawnSnoozedUntil: string | null = null;
      if (next > today) {
        const { data: us } = await db
          .from("user_settings").select("timezone").eq("user_id", req.user!.id).maybeSingle();
        const tz = (us?.timezone as string | null) || "Asia/Jerusalem";
        spawnStatus = "snoozed";
        spawnSnoozedUntil = utcInstantForLocalHour(next, 7, tz).toISOString();
      }
      const { data: created, error: recErr } = await db
        .from("tasks")
        .insert({
          user_id: req.user!.id,
          organization_id: req.org!.id,
          title: data.title, title_he: data.title_he, description: data.description,
          priority: data.priority, task_type: data.task_type ?? "action",
          // A recurring occurrence inherits its parent's effort size and context
          // — the daily method must not silently re-classify it to the DB default.
          size: data.size ?? "medium", context: data.context,
          status: spawnStatus, manually_verified: true,
          snoozed_until: spawnSnoozedUntil,
          due_date: next, due_time: data.due_time,
          reminder_at: nextReminder,
          recurrence_rule: data.recurrence_rule,
          recurrence_until: data.recurrence_until,
          recurrence_parent_id: (data.recurrence_parent_id as string | null) ?? data.id,
          project_id: data.project_id, tags: data.tags, checklist,
        })
        .select("*, source_messages(id, source_type, source_id, source_url, serial_display), projects(id, name, name_he, color, parent_id)")
        .single();
      // Best-effort: completion already succeeded. Surface the error in logs but
      // don't fail the request — the user can recreate the next instance by hand.
      if (recErr) console.error(`[tasks/complete] failed to spawn next recurrence for ${data.id}: ${recErr.message}`);
      nextTask = created;
    }
  }

  res.json({ task: data, next_task: nextTask });
});

/** POST /tasks/:id/snooze */
router.post("/tasks/:id/snooze", async (req: Request, res: Response) => {
  // Default: tomorrow at 9am in the USER's timezone (not server time — Railway
  // runs UTC, so setHours(9) would wake the task at 12:00 Israel). Body can
  // pass { until: ISO } to override.
  let until: string;
  if (req.body?.until && typeof req.body.until === "string") {
    until = req.body.until;
  } else {
    const { data: us } = await db
      .from("user_settings").select("timezone").eq("user_id", req.user!.id).maybeSingle();
    const tz = (us?.timezone as string | null) || "Asia/Jerusalem";
    // Today's calendar date in the user's tz (en-CA formats as YYYY-MM-DD),
    // then +1 day in date space — safe across month/year boundaries.
    const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const tomorrow = new Date(Date.parse(`${todayLocal}T00:00:00.000Z`) + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    until = utcInstantForLocalHour(tomorrow, 9, tz).toISOString();
  }

  // Bump snooze_count atomically via a fresh read+write — Postgres has no `+1` shorthand here.
  const { data: current } = await db
    .from("tasks")
    .select("snooze_count")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (!current) return res.status(404).json({ error: "task not found in this org" });

  // The chosen snooze time is always honored as-is. We deliberately do NOT
  // clamp it back to the task's deadline: when the deadline was today or in
  // the past, clamping produced a moment already behind us, so the next
  // reminders-check run woke the task immediately — turning every snooze into
  // a no-op and resurfacing the task over and over (the T271 loop). The user
  // owns when they want to see the task again.

  const { data, error } = await db
    .from("tasks")
    .update({
      status: "snoozed",
      snoozed_until: until,
      snooze_count: (current.snooze_count ?? 0) + 1,
      status_changed_at: new Date().toISOString(),
    })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, status, snoozed_until, snooze_count")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ task: data });
});

/** POST /tasks/:id/seen — also counts as an interaction: refreshes the aging
 *  clock and clears the "returned from snooze" chip. */
router.post("/tasks/:id/seen", async (req: Request, res: Response) => {
  const now = new Date().toISOString();
  const { error } = await db
    .from("tasks")
    .update({ seen_at: now, last_interaction_at: now, woke_from_snooze_at: null })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** GET /work-calendar — blocked (non-working) dates for business-day math in
 *  the UI: global Israeli holidays (org_id NULL) + this org's own rows. The
 *  Mon–Fri weekend is computed client-side; this returns only calendar dates.
 *  Same source as the smrtPlan engine (smrtplan_blocked_days). */
router.get("/work-calendar", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtplan_blocked_days")
    .select("blocked_date")
    .or(`org_id.is.null,org_id.eq.${req.org!.id}`);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ blocked_days: (data ?? []).map((r) => r.blocked_date as string) });
});

/** POST /tasks/:id/materials/upload — upload a file to task-materials bucket.
 *  Body: { filename: string, mime?: string, data: <base64-string> }
 *  Returns: { url, file_path, file_size, file_mime, filename }
 *  Frontend then PATCHes /tasks/:id with the new task_materials array
 *  containing this file entry (read-modify-write).
 *  Size cap: 7MB raw (express.json limit is 10mb; base64 inflates ~1.37x). */
router.post("/tasks/:id/materials/upload", async (req: Request, res: Response) => {
  const { filename, mime, data } = req.body ?? {};
  if (!filename || typeof filename !== "string") {
    return res.status(400).json({ error: "filename is required" });
  }
  if (!data || typeof data !== "string") {
    return res.status(400).json({ error: "data (base64) is required" });
  }

  // Confirm task is in this org before we burn storage.
  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (tErr)  return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found in this org" });

  const buf = Buffer.from(data, "base64");
  if (buf.length > 7 * 1024 * 1024) {
    return res.status(413).json({ error: "file too large (max 7MB)" });
  }

  // Supabase Storage keys must be ASCII — Hebrew filenames, spaces, and other
  // non-ASCII / unsafe characters trigger "Invalid key" and the upload fails.
  // Keep the original name (displayName) for the user-facing title, but build
  // an ASCII-safe slug for the storage path so the key is always valid.
  const displayName = filename.trim().slice(0, 200);
  const dot  = displayName.lastIndexOf(".");
  const ext  = dot > 0 ? displayName.slice(dot).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 20) : "";
  const stem = (dot > 0 ? displayName.slice(0, dot) : displayName)
    .replace(/[^\x20-\x7E]/g, "")        // drop non-ASCII (Hebrew, emoji, …)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")   // collapse remaining unsafe chars + spaces
    .replace(/_+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100);
  const safeName = (stem || "file") + ext;
  const path = `${req.org!.id}/${task.id}/${randomUUID()}-${safeName}`;
  const contentType = (typeof mime === "string" && mime) || "application/octet-stream";

  const { error: uploadErr } = await db.storage
    .from("task-materials")
    .upload(path, buf, { contentType, upsert: false });
  if (uploadErr) return res.status(500).json({ error: `storage upload: ${uploadErr.message}` });

  // 1-year signed URL — long enough that the UI doesn't refresh links on
  // every view, short enough that revocation is meaningful.
  const { data: signed, error: signErr } = await db.storage
    .from("task-materials")
    .createSignedUrl(path, 60 * 60 * 24 * 365);
  if (signErr) return res.status(500).json({ error: `sign url: ${signErr.message}` });

  res.status(201).json({
    url:       signed?.signedUrl ?? "",
    file_path: path,
    file_size: buf.length,
    file_mime: contentType,
    filename:  displayName,
  });
});

/** POST /tasks/:id/updates — append a manual note to updates[].
 *  After the note is saved, refresh task.description via Haiku so the
 *  description reflects the current state of the task ("where everything
 *  stands at a glance"). The user-facing toast already says "added";
 *  the description refresh happens best-effort and does not block the
 *  201 response if AI fails. */
router.post("/tasks/:id/updates", async (req: Request, res: Response) => {
  const { content, type = "note" } = req.body ?? {};
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }

  const { data: current } = await db
    .from("tasks")
    .select("updates, title, title_he, description, due_date")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (!current) return res.status(404).json({ error: "task not found in this org" });

  const entry = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    type,
    actor: "user",
    content: content.trim(),
    actor_user_id: req.user!.id,
  };

  const next = [...((current.updates as unknown[]) ?? []), entry];

  const { error } = await db
    .from("tasks")
    .update({ updates: next, updated_at: new Date().toISOString() })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });

  // Fire-and-forget AI description refresh. Don't await — return the
  // entry immediately so the client UX is snappy. The refresh writes to
  // task.description; the client's onUpdate() refetch picks it up.
  void refreshTaskDescription({
    taskId: req.params.id,
    orgId: req.org!.id,
    userId: req.user!.id,
    currentDescription: (current.description as string | null) ?? "",
    title: (current.title_he as string | null) ?? (current.title as string | null) ?? "",
    dueDate: (current.due_date as string | null) ?? null,
    updates: next,
  }).catch((e) => {
    console.error("[updates] description refresh failed:", (e as Error).message);
  });

  res.status(201).json({ update: entry });
});

/** Re-synthesize task.description so it reflects "where everything
 *  stands right now" — used after both manual notes and (eventually)
 *  auto updates from ai-process. Cheap Haiku call. */
async function refreshTaskDescription(opts: {
  taskId: string;
  orgId: string;
  userId: string;
  currentDescription: string;
  title: string;
  dueDate: string | null;
  updates: unknown[];
}): Promise<void> {
  // Take the last ~10 updates in chronological order — enough context
  // for Haiku to write a coherent state summary without blowing the
  // input budget on huge histories.
  const recent = (opts.updates as Array<Record<string, unknown>>)
    .slice(-10)
    .map((u, i) => {
      const ts = typeof u.created_at === "string" ? u.created_at : "";
      const actor = typeof u.actor === "string" ? u.actor : "system";
      const content = typeof u.content === "string" ? u.content : "";
      return `[${i + 1}] (${ts}, ${actor}) ${content}`;
    })
    .join("\n");

  const systemPrompt = `אתה משכתב את התיאור של משימה כך שישקף את ה"איפה הדברים עומדים עכשיו".

קלט: תיאור קודם של המשימה, וכל העדכונים שנוספו אליה (מהמשתמש או מה-AI), בסדר כרונולוגי.

פלט: תיאור חדש (עד 350 תווים) בעברית, שמסכם את המצב הנוכחי של המשימה — מה כבר נעשה, מה ממתין, ומי החייב לבצע את הצעד הבא. כתוב בצורה שמשתמש יבין בהצצה אחת איפה הדברים עומדים.

כללי ניסוח חשובים (חובה) — שלושה רובדים, אל תערבב ביניהם:

(1) אפשרות / תנאי / ניסיון:
    דוגמאות: "אנסה", "אולי", "אם יהיה לי זמן", "אני יכול לנסות",
             "I can try", "I might", "I'll see", "perhaps".
    נסח: "אמר שיכול לנסות" / "הציע לבדוק" / "ציין שאולי יבדוק".
    אסור: "התחייב" / "הבטיח".

(2) הצהרת כוונה בעתיד פשוט (ללא לשון הבטחה):
    דוגמאות: "אתקשר", "אשלח", "אעדכן", "אעביר עד מחר",
             "I will call", "I'll send tomorrow", "I'm going to pay".
    נסח: "אמר שיתקשר" / "אמר שישלח" / "ציין שיעדכן".
    עתיד פשוט הוא הצהרה — לא הבטחה. הדובר אמר מה בכוונתו לעשות,
    הוא לא הבטיח. אסור לכתוב "התחייב" / "הבטיח" עבור עתיד פשוט —
    זה מטעה את המשתמש.

(3) הבטחה מפורשת בלבד (חובה לשון הבטחה):
    דוגמאות: "מבטיח שאתקשר", "מתחייב לשלוח", "ערב לכך ש", "נשבע ש",
             "I promise to call", "I commit", "I guarantee", "you have my word".
    נסח: "התחייב להתקשר" / "הבטיח לשלוח" — מותר אך ורק כאן.
    הדובר חייב להשתמש בלשון הבטחה מפורשת (מבטיח / מתחייב / ערב / נשבע
    / promise / commit / guarantee).

דוגמאות:
  קלט: "I will call AT&T tomorrow"
  שגוי: "Chanoch התחייב להתקשר ל-AT&T"
  נכון: "Chanoch אמר שיתקשר ל-AT&T מחר"

  קלט: "I can try"
  שגוי: "Chanoch התחייב לבדוק"
  נכון: "Chanoch אמר שיכול לנסות"

  קלט: "I promise to send the report by Friday"
  נכון: "Chanoch הבטיח לשלוח את הדו״ח עד שישי" (יש "promise" → "הבטיח")

בספק בין (2) ל-(3): ברירת מחדל "אמר ש..." / "ציין ש...".

כלל היצמדות למקור (חובה) — אל תמציא:
ייחס לכל צד אך ורק את מה שנאמר במפורש. זה נפרד מכלל הרבדים: גם כשבחרת
"אמר ש" נכון, אסור להמציא את המושא או ההיקף של האמירה, ואסור להעביר נושא
שצד אחד העלה אל צד אחר.
- אמירה מעורפלת/סתמית ("יטופל", "נטפל בזה", "אני אדאג") אינה התחייבות
  למשימה ספציפית. צטט אותה כפי שהיא: 'אמר ש"יטופל"' — אל תרחיב ל-
  "אמר/התחייב שיבדוק את <נושא ספציפי>".
- אם צד א' שאל על נושא X וצד ב' ענה רק "לא יודע", אסור לכתוב שצד ב'
  יבדוק / התחייב לבדוק את X. הוא לא אמר דבר על X מעבר לכך שאינו יודע.
- נושא שהמשתמש העלה (או אמר שאינו יודע לגביו) אינו הופך אוטומטית למשהו
  שהצד השני התחייב לטפל בו. אם נושא נותר ללא בעלים — כתוב שהוא עדיין פתוח,
  אל תייחס אותו לאף אחד.

כלל תאריכים (חובה) — אסור מילות-זמן-יחסיות:
כשאתה מתאר מתי משימה / פגישה / אירוע מתוכננים או צריכים להתבצע, כתוב תמיד
את התאריך המוחלט בלוח השנה (למשל "2 ביוני" או "ב-2/6"). אסור להשתמש ב-
"היום" / "מחר" / "אתמול" / "מחרתיים" כדי לתאר את מועד המשימה — התיאור
נשמר לאורך זמן, ומילים יחסיות מתיישנות והופכות שגויות כבר למחרת. אם
התיאור הקודם כתב "היום"/"מחר" לגבי מועד — החלף במועד המוחלט (השתמש בשדה
"מועד המשימה" שמסופק למטה, או בתאריך המוחלט שכבר מופיע בטקסט). חריג יחיד:
ציטוט מילולי של דברי אדם ("אמר שיתקשר מחר") מותר — זה דיווח על מה שנאמר,
לא קביעת מועד.

בנוסף לתיאור, עדכן גם את כותרת המשימה כך שתשקף את הצעד הבא הנדרש עכשיו:
- כותרת בעברית בלבד, מתחילה בפועל פעולה (לענות / לאשר / להתקשר / לבדוק /
  לשלם / לתאם / להגיש...), קצרה (עד ~60 תווים).
- אם הצעד הבא לא השתנה — החזר את הכותרת הקודמת כמות שהיא.
- אל תמציא פעולה שלא עולה מהעדכונים; בספק שמור על הכותרת הקודמת.

כללים נוספים:
- שמור על URLs מלאים מהמקור verbatim, אל תקצר לדומיין בלבד.
- אל תוסיף הקדמות.

החזר JSON בלבד בפורמט: {"title": "<כותרת מעודכנת>", "description": "<תיאור מעודכן>"}`;

  const userMessage = `כותרת המשימה: ${opts.title}
מועד המשימה (due_date): ${opts.dueDate || "(לא נקבע)"}

תיאור קודם:
${opts.currentDescription || "(ריק)"}

העדכונים שנכנסו לפי הסדר:
${recent || "(אין עדכונים)"}

שכתב את הכותרת והתיאור.`;

  const { content } = await simpleCall(
    "haiku",
    systemPrompt,
    userMessage,
    700,
    { component: "smrttask.tasks.update.refresh_summary", userId: opts.userId },
  );

  // Expect { title, description }. Be tolerant: if the model returns plain
  // text (no JSON), treat it as the description and leave the title as-is.
  let title: string | null = null;
  let description: string | null = null;
  try {
    const parsed = parseJsonResponse<{ title?: string; description?: string }>(content);
    if (parsed && typeof parsed === "object") {
      title = typeof parsed.title === "string" ? parsed.title.trim() : null;
      description = typeof parsed.description === "string" ? parsed.description.trim() : null;
    }
  } catch { /* fall through to plain-text handling */ }
  if (description === null && title === null) {
    description = content.trim().replace(/^["'`]+|["'`]+$/g, "");
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (description) patch.description = description.slice(0, 1000);
  if (title) {
    // Bilingual title columns: the UI shows title_he in Hebrew, falling back
    // to title. Keep both in sync with the AI-refreshed Hebrew title.
    patch.title_he = title.slice(0, 200);
    patch.title = title.slice(0, 200);
  }
  if (!("description" in patch) && !("title_he" in patch)) return;

  await db
    .from("tasks")
    .update(patch)
    .eq("organization_id", opts.orgId)
    .eq("id", opts.taskId);
}

/**
 * POST /tasks/:id/approve-as-project
 *
 * Approves a project_suggestion task: creates a new project seeded with the
 * cluster's keywords + key_contacts, archives the suggestion, and bulk-links
 * all clustered tasks to the new project.
 *
 * The suggestion task's ai_generated_content holds:
 *   [{ action_label: "project_cluster", clustered_task_ids: [...], keywords: [...], key_contacts: [...] }]
 */
router.post("/tasks/:id/approve-as-project",
  requireFullTask, async (req: Request, res: Response) => {
    const { data: task, error: tErr } = await db
      .from("tasks")
      .select("id, title, title_he, task_type, ai_generated_content")
      .eq("organization_id", req.org!.id)
      .eq("id", req.params.id)
      .maybeSingle();

    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!task) return res.status(404).json({ error: "task not found in this org" });
    if (task.task_type !== "project_suggestion") {
      return res.status(400).json({ error: "task is not a project_suggestion" });
    }

    const cluster = ((task.ai_generated_content as Array<Record<string, unknown>> | null) ?? [])
      .find((e) => e.action_label === "project_cluster");
    const clusteredTaskIds = (cluster?.clustered_task_ids as string[] | undefined) ?? [];
    const keywords         = (cluster?.keywords as string[] | undefined) ?? [];
    const keyContacts      = (cluster?.key_contacts as string[] | undefined) ?? [];

    // 1. Create the project
    const { data: project, error: pErr } = await db
      .from("projects")
      .insert({
        user_id: req.user!.id,
        organization_id: req.org!.id,
        name: task.title as string,
        name_he: task.title_he as string | null,
        template_type: "personal",
        keywords,
        key_contacts: keyContacts,
      })
      .select("id, name, name_he, color")
      .single();
    if (pErr) return res.status(500).json({ error: `project create: ${pErr.message}` });

    // 2. Archive the suggestion task & stamp the project_id
    const { error: archiveErr } = await db
      .from("tasks")
      .update({
        status: "archived",
        manually_verified: true,
        project_id: project.id,
        completed_at: new Date().toISOString(),
        status_changed_at: new Date().toISOString(),
      })
      .eq("id", task.id);
    if (archiveErr) console.error("[approve-as-project] archive error:", archiveErr.message);

    // 3. Bulk-link clustered tasks to the new project
    let linkedCount = 0;
    if (clusteredTaskIds.length > 0) {
      const { error: lErr, count } = await db
        .from("tasks")
        .update({ project_id: project.id, project_confidence: 1 }, { count: "exact" })
        .eq("organization_id", req.org!.id)
        .in("id", clusteredTaskIds);
      if (lErr) console.error("[approve-as-project] link error:", lErr.message);
      linkedCount = count ?? 0;
    }

    res.json({ project, linked_tasks: linkedCount });
  },
);

/** GET /tasks/:id/trail
 *  Returns the AI decision trail for the message that produced this task:
 *  source_message details + the most-recent log_entry. Used by the
 *  collapsible "Why did the AI create this?" block in TaskDetail and
 *  the MessageSuggestions cards. Returns 404 if the task has no
 *  source_message_id (manually-created task).
 */
router.get("/tasks/:id/trail", async (req: Request, res: Response) => {
  // First confirm the task is in this org so we don't leak across tenants.
  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id, source_message_id")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (tErr)  return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found in this org" });
  if (!task.source_message_id) {
    return res.json({ source: null, log: null });
  }

  const [{ data: sm }, { data: logs }] = await Promise.all([
    db
      .from("source_messages")
      .select("id, source_type, source_id, source_url, serial_display, sender, sender_email, sender_phone, subject, body_text, received_at, ai_classification")
      .eq("id", task.source_message_id)
      .maybeSingle(),
    db
      .from("log_entries")
      // Full set, matching the smrtTask log page so the ✨ panel can show the
      // same detail: pre-classification, confidences (in `details`), duration.
      .select("classification_reason, ai_classification, pre_classification, ai_model_used, ai_input_tokens, ai_output_tokens, ai_cost_usd, processing_duration_ms, details, status, error_message, created_at")
      .eq("source_message_id", task.source_message_id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  res.json({
    source: sm ?? null,
    log:    logs?.[0] ?? null,
  });
});

/**
 * GET /source-messages/:id — full content of a single source message.
 *
 * Backs the in-app email reader: mobile Gmail can't deep-link to a specific
 * message (it always lands on the inbox), so on mobile we render the email's
 * stored content in-app instead of bouncing to Gmail. Scoped to the calling
 * user via source_messages.user_id — a user only reads their own messages.
 */
router.get("/source-messages/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("source_messages")
    .select("id, source_type, source_url, serial_display, sender, sender_email, subject, body_text, received_at")
    .eq("id", req.params.id)
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "source message not found" });
  res.json({ source: data });
});

// ── dismissal reasons ──────────────────────────────────────────────────────
// Closed set. The UI exposes exactly three: two fixed codes that map to a
// deterministic rules_memory entry, plus "custom" which routes the free-text
// reason through Claude Haiku to propose a rule for the user to approve in
// /settings/smrttask/rules.
//   • sender_unimportant → rule_type=skip   (or bot, for WhatsApp)
//   • spam               → rule_type=skip_spam
//   • custom             → LLM-suggested rule, status='pending'
// sender_unimportant + spam are also "cascading" — when set, all OTHER
// pending suggestions from the same sender get archived in the same call
// so the user doesn't have to dismiss each one individually.
const DISMISSAL_CODES = new Set([
  "sender_unimportant",
  // "from this sender, but only this TYPE of mail" — narrow rule that pairs
  // the sender with a subject_contains keyword extracted by an AI proposer
  // (and confirmable by the user in the dialog). Distinct from
  // sender_unimportant which blocks ALL mail from the sender.
  "sender_type_unimportant",
  "spam",
  "custom",
]);

// Codes that cascade: dismissing one suggestion also dismisses other
// pending suggestions in the same scope. sender_unimportant + spam cascade
// over ALL pending tasks from the same sender. sender_type_unimportant
// cascades over a narrower scope (same sender AND subject keyword) — its
// preview is computed separately because the keyword affects the count.
const CASCADING_CODES = new Set(["sender_unimportant", "spam", "sender_type_unimportant"]);

type SenderResolution = {
  /** column on source_messages we filter by */
  filterCol: "sender_email" | "sender_phone";
  /** normalised value to filter by (lower-case email or digits-only phone) */
  filterVal: string;
  /** human-readable trigger string we store in rules_memory + show in UI */
  trigger: string;
  ruleType: "skip" | "skip_spam" | "bot";
  category: string | null;
};

/** Resolve a source_message into the sender-filter we use for both rule
 *  creation and cascade lookups. Returns null when we can't derive one
 *  (e.g. Drive/Calendar rows have no sender). */
function resolveSender(
  sm: { source_type?: string | null; sender_email?: string | null; sender_phone?: string | null } | null,
  reasonCode: string,
): SenderResolution | null {
  if (!sm) return null;
  if (sm.source_type === "gmail" || sm.source_type === "gmail_sent") {
    if (!sm.sender_email) return null;
    const v = sm.sender_email.toLowerCase();
    return {
      filterCol: "sender_email",
      filterVal: v,
      trigger:   `from=${v}`,
      ruleType:  reasonCode === "spam" ? "skip_spam" : "skip",
      category:  null,
    };
  }
  if (sm.source_type === "whatsapp" || sm.source_type === "whatsapp_echo") {
    const phone = (sm.sender_phone ?? "").replace(/\D/g, "");
    if (!phone) return null;
    return {
      filterCol: "sender_phone",
      filterVal: phone,
      trigger:   `phone=${phone}`,
      ruleType:  "bot",
      category:  "bot",
    };
  }
  return null;
}

/** GET /tasks/:id/dismiss-preview?reason_code=<code>
 *  How many OTHER pending suggestions would also be dismissed if the user
 *  picked this reason. The UI fetches this when the user selects a
 *  cascading reason so we can show "+5 other suggestions from this sender".
 *  Non-cascading codes return cascade_count=0 unconditionally. */
router.get("/tasks/:id/dismiss-preview", requireFullTask, async (req: Request, res: Response) => {
  const reasonCode = String(req.query.reason_code ?? "");
  if (!CASCADING_CODES.has(reasonCode)) {
    return res.json({ cascade_count: 0, cascade_trigger: null });
  }

  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id, user_id, source_message_id, source_messages(source_type, sender_email, sender_phone)")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (tErr)  return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found in this org" });
  if (!task.source_message_id) return res.json({ cascade_count: 0, cascade_trigger: null });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smRawPv = (task as any).source_messages;
  const smPv = (Array.isArray(smRawPv) ? smRawPv[0] : smRawPv) as {
    source_type?: string | null; sender_email?: string | null; sender_phone?: string | null;
  } | null;
  const sender = resolveSender(smPv, reasonCode);
  if (!sender) return res.json({ cascade_count: 0, cascade_trigger: null });

  // Find every source_message from this sender belonging to the user…
  const { data: matchingSms } = await db
    .from("source_messages")
    .select("id")
    .eq("user_id", task.user_id)
    .eq(sender.filterCol, sender.filterVal);
  const smIds = (matchingSms ?? []).map((r) => r.id).filter((id) => id !== task.source_message_id);
  if (smIds.length === 0) {
    return res.json({ cascade_count: 0, cascade_trigger: sender.trigger });
  }

  // …and count how many of THEIR pending tasks live in this org.
  const { count } = await db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", req.org!.id)
    .eq("status", "inbox")
    .in("source_message_id", smIds);

  res.json({ cascade_count: count ?? 0, cascade_trigger: sender.trigger });
});

/** POST /tasks/:id/dismiss
 *  Body: { reason_code: string, reason_text?: string, cascade?: boolean }
 *  Archives the task with manually_verified=true, records the dismissal
 *  reason on the row, and — for sender-targeted codes — writes a
 *  rules_memory entry derived from the linked source_message.
 *  When cascade=true (default for cascading codes) all OTHER pending
 *  suggestions from the same sender are archived in the same call.
 */
router.post("/tasks/:id/dismiss", requireFullTask, async (req: Request, res: Response) => {
  const reasonCode = (req.body?.reason_code ?? "") as string;
  const reasonText = typeof req.body?.reason_text === "string" ? req.body.reason_text.trim() : "";
  const cascadeRequested = req.body?.cascade !== false;  // default true; pass false to opt out
  // For sender_type_unimportant only: the subject keyword the user
  // confirmed in the dialog (AI-proposed and possibly hand-edited). We
  // require a non-empty value — without it the rule would collapse to
  // `from=X` (block ALL mail from sender), which defeats the whole point
  // of the "only this type" option.
  const subjectKeyword = typeof req.body?.subject_keyword === "string"
    ? req.body.subject_keyword.trim()
    : "";

  if (!DISMISSAL_CODES.has(reasonCode)) {
    return res.status(400).json({ error: "invalid reason_code" });
  }
  if (reasonCode === "custom" && !reasonText) {
    return res.status(400).json({ error: "reason_text is required when reason_code='custom'" });
  }
  if (reasonCode === "sender_type_unimportant" && !subjectKeyword) {
    return res.status(400).json({ error: "subject_keyword is required when reason_code='sender_type_unimportant'" });
  }
  // `&` is the clause separator for composite triggers. A keyword that
  // contains `&` would split the persisted trigger into bogus clauses on
  // the next parse. Reject it; the user can re-enter without the `&`.
  if (reasonCode === "sender_type_unimportant" && subjectKeyword.includes("&")) {
    return res.status(400).json({ error: "subject_keyword cannot contain the '&' character" });
  }

  // Narrow dismiss is gmail-only: `subject_contains=` has no meaning for
  // WhatsApp / Calendar messages, which have no subject field. The UI
  // hides the option for non-gmail tasks; this is the server-side guard.
  if (reasonCode === "sender_type_unimportant") {
    const { data: smGate } = await db
      .from("tasks")
      .select("source_messages(source_type)")
      .eq("organization_id", req.org!.id)
      .eq("id", req.params.id)
      .maybeSingle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const smGateRaw = (smGate as any)?.source_messages;
    const smGateRow = (Array.isArray(smGateRaw) ? smGateRaw[0] : smGateRaw) as { source_type?: string | null } | null;
    const srcType = smGateRow?.source_type ?? "";
    if (srcType !== "gmail" && srcType !== "gmail_sent") {
      return res.status(400).json({ error: "narrow dismiss is only available for email suggestions" });
    }
  }

  // Load task + linked source message in one round-trip
  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id, user_id, source_message_id, source_messages(source_type, sender_email, sender_phone, sender, subject, serial_display)")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (tErr)  return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found in this org" });

  // Dismiss + record reason. Separate status from completed tasks so the
  // "Completed" tab only contains items the user explicitly finished.
  const now = new Date().toISOString();
  const dismissPatch = {
    status: "dismissed",
    manually_verified: true,
    dismissal_reason_code: reasonCode,
    dismissal_reason_text: reasonText || null,
    status_changed_at: now,
  } as const;

  const { error: uErr } = await db
    .from("tasks")
    .update(dismissPatch)
    .eq("id", task.id);
  if (uErr) return res.status(500).json({ error: uErr.message });

  // Sender resolution drives BOTH rule creation and cascade dismissal.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smRaw = (task as any).source_messages;
  const sm = (Array.isArray(smRaw) ? smRaw[0] : smRaw) as {
    source_type?: string | null; sender_email?: string | null; sender_phone?: string | null;
    sender?: string | null; subject?: string | null;
  } | null;
  const sender = CASCADING_CODES.has(reasonCode) ? resolveSender(sm, reasonCode) : null;

  // For sender_type_unimportant we compose a NARROW trigger from the
  // sender filter plus the user-confirmed subject keyword. The rule is
  // still rule_type=skip (or skip_spam for WhatsApp bots — though
  // sender_type_unimportant is currently gated to gmail-only in the
  // propose endpoint, so this branch is effectively Gmail).
  const isNarrow = reasonCode === "sender_type_unimportant" && subjectKeyword.length > 0;
  const composedTrigger = sender && isNarrow
    ? `${sender.trigger}&subject_contains=${subjectKeyword}`
    : sender?.trigger ?? null;

  // 1. rules_memory — block the sender (or sender+type) for future syncs.
  let ruleCreated: { id: string; trigger: string; rule_type: string } | null = null;
  if (sender && composedTrigger) {
    const { data: rule, error: rErr } = await db
      .from("rules_memory")
      .insert({
        user_id: task.user_id,
        app_slug: "smrttask",
        trigger:    composedTrigger,
        rule_type:  sender.ruleType,
        category:   sender.category,
        action:     "skip",
        reason:     reasonText || `User dismissed task with reason '${reasonCode}'`,
        created_by: "user",
      })
      .select("id, trigger, rule_type")
      .maybeSingle();
    if (rErr) {
      // Don't fail the dismissal — the task is already archived. Just log.
      console.error("[dismiss] rules_memory insert error:", rErr.message);
    } else {
      ruleCreated = rule;
    }
  }

  // 2. Cascade — archive every OTHER pending suggestion that matches the rule.
  //    For sender_unimportant/spam:        same sender, any subject.
  //    For sender_type_unimportant:        same sender AND subject contains keyword.
  //    Skipped when cascade=false in body (the dialog's "סגור גם N אחרות" checkbox).
  let cascadedCount = 0;
  if (sender && cascadeRequested) {
    // For narrow rules we need source_messages.subject in the filter step.
    // The query is the same shape either way; we always pull subject so the
    // narrow path can substring-match in JS (PostgREST has ilike support
    // but mixing ilike with .in() for a list of subjects is messier than
    // post-filtering the small candidate set we already have).
    const { data: matchingSms } = await db
      .from("source_messages")
      .select("id, subject")
      .eq("user_id", task.user_id)
      .eq(sender.filterCol, sender.filterVal);

    const candidateIds = (matchingSms ?? [])
      .filter((r) => r.id !== task.source_message_id)
      .filter((r) => {
        if (!isNarrow) return true;
        const subj = (r.subject ?? "").toLowerCase();
        return subj.includes(subjectKeyword.toLowerCase());
      })
      .map((r) => r.id);

    if (candidateIds.length > 0) {
      const { count, error: cErr } = await db
        .from("tasks")
        .update(dismissPatch, { count: "exact" })
        .eq("organization_id", req.org!.id)
        .eq("status", "inbox")
        .in("source_message_id", candidateIds);
      if (cErr) {
        console.error("[dismiss] cascade update error:", cErr.message);
      } else {
        cascadedCount = count ?? 0;
      }
    }
  }

  // 3. Custom reason → ask Claude Haiku to propose a rule, store as pending
  //    suggestion for the user to approve in /settings/smrttask/rules.
  //    Failure is non-fatal: the task is already archived.
  let rulePending: { trigger: string; rule_type: string; suggestion_confidence: number } | null = null;
  if (reasonCode === "custom" && reasonText) {
    try {
      const { data: fullTask } = await db
        .from("tasks")
        .select("title_he, title, description, related_contact, related_contact_email, related_contact_phone")
        .eq("id", task.id)
        .maybeSingle();
      const taskDesc = [
        `Task: ${fullTask?.title_he ?? fullTask?.title ?? ""}`,
        fullTask?.description ? `Description: ${fullTask.description}` : "",
        fullTask?.related_contact ? `Contact: ${fullTask.related_contact}` : "",
        sm?.source_type ? `Source: ${sm.source_type}` : "",
        sm?.sender ? `Sender: ${sm.sender}` : "",
        sm?.sender_email ? `Email: ${sm.sender_email}` : "",
        sm?.sender_phone ? `Phone: ${sm.sender_phone}` : "",
      ].filter(Boolean).join("\n");

      const proposal = await proposeRuleFromCustomDismiss(reasonText, taskDesc);
      if (proposal && proposal.trigger && proposal.rule_type) {
        // Belt-and-suspenders: the proposer already filters rule_type, but the
        // value is AI-parsed — an out-of-set value would fail the rules_memory
        // CHECK constraint at insert time. Fall back to 'skip' (the default
        // rule_type this flow writes for dismissals; the row is a pending
        // suggestion the user reviews before it activates).
        let ruleType = proposal.rule_type;
        if (!RULE_MEMORY_RULE_TYPES.has(ruleType)) {
          console.error(`[dismiss/custom] AI proposed invalid rule_type '${ruleType}' — falling back to 'skip'`);
          ruleType = "skip";
        }
        const conf = typeof proposal.confidence === "number"
          ? Math.max(0, Math.min(1, proposal.confidence))
          : 0.6;
        const { data: pendingRow, error: pErr } = await db
          .from("rules_memory")
          .insert({
            user_id: task.user_id,
            app_slug: "smrttask",
            trigger:    proposal.trigger,
            rule_type:  ruleType,
            action:     ruleType === "skip" || ruleType === "skip_spam" ? "skip" : null,
            reason:     proposal.reason || `Proposed from user dismissal: "${reasonText}"`,
            is_active:  false,
            created_by: "claude",
            suggestion_status: "pending",
            suggestion_confidence: conf,
          })
          .select("trigger, rule_type, suggestion_confidence")
          .maybeSingle();
        if (pErr) {
          console.error("[dismiss/custom] rules_memory pending insert error:", pErr.message);
        } else if (pendingRow) {
          rulePending = {
            trigger: pendingRow.trigger,
            rule_type: pendingRow.rule_type,
            suggestion_confidence: pendingRow.suggestion_confidence ?? conf,
          };
        }
      }
    } catch (e) {
      console.error("[dismiss/custom] proposeRuleFromCustomDismiss failed:", e);
    }
  }

  await emitEvent(req.org!.id, "smrttask", "task.dismissed", "task", task.id, {
    reason_code: reasonCode,
    rule_created: !!ruleCreated,
    rule_pending: !!rulePending,
    cascaded_count: cascadedCount,
  });

  res.json({
    ok: true,
    rule_created: ruleCreated,
    rule_pending: rulePending,
    cascaded_count: cascadedCount,
  });
});

/** POST /tasks/:id/dismiss-fast
 *  Archive a single suggestion with NO learning, NO LLM, NO cascade. The UI's
 *  unannotated X button uses this when the user just wants the item out of
 *  their inbox without spending tokens or producing a rule. */
router.post("/tasks/:id/dismiss-fast", requireFullTask, async (req: Request, res: Response) => {
  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (tErr)  return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found in this org" });

  const { error: uErr } = await db
    .from("tasks")
    .update({
      // Dismissed suggestions get a status of their own so the "Completed"
      // tab — which the user reserves for tasks they explicitly finished —
      // stays clean. `archived` is now only set by the /complete endpoint.
      status: "dismissed",
      manually_verified: true,
      dismissal_reason_code: null,
      dismissal_reason_text: null,
      status_changed_at: new Date().toISOString(),
    })
    .eq("id", task.id);
  if (uErr) return res.status(500).json({ error: uErr.message });

  await emitEvent(req.org!.id, "smrttask", "task.dismissed", "task", task.id, {
    reason_code: null, fast: true,
  });

  res.json({ ok: true });
});

/** POST /tasks/bulk-approve
 *  Body: { task_ids: string[] }
 *  Marks each task in the active org as manually_verified=true and stamps
 *  seen_at. Used by the suggestion list's bulk-action toolbar. */
router.post("/tasks/bulk-approve", requireFullTask, async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.task_ids) ? (req.body.task_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return res.status(400).json({ error: "task_ids required" });

  const now = new Date().toISOString();
  const { data: touched, error } = await db
    .from("tasks")
    .update({ manually_verified: true, seen_at: now })
    .eq("organization_id", req.org!.id)
    .in("id", ids)
    .select("id");
  if (error) return res.status(500).json({ error: error.message });

  // Forensics — same as the single-task approve flip in PATCH. Log only the
  // rows the org-scoped update ACTUALLY touched (a bogus/cross-org id in the
  // request must neither fail the batch on FK nor write a false record).
  const touchedIds = (touched ?? []).map((r) => r.id as string);
  if (touchedIds.length > 0) {
    const { error: actErr } = await db.from("task_activities").insert(
      touchedIds.map((id) => ({
        user_id: req.user!.id,
        task_id: id,
        activity_type: "approved",
        new_value: "verified",
        note: "approved via bulk-approve",
        actor: "user",
      })),
    );
    if (actErr) console.error("[bulk-approve] activity log failed:", actErr.message);
  }

  res.json({ ok: true, approved_count: touchedIds.length });
});

/** POST /tasks/bulk-dismiss-fast
 *  Body: { task_ids: string[] }
 *  Same semantics as dismiss-fast but for a batch — archives without
 *  learning, cascading, or LLM calls. */
router.post("/tasks/bulk-dismiss-fast", requireFullTask, async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.task_ids) ? (req.body.task_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return res.status(400).json({ error: "task_ids required" });

  const { count, error } = await db
    .from("tasks")
    .update({
      status: "dismissed",
      manually_verified: true,
      dismissal_reason_code: null,
      dismissal_reason_text: null,
      status_changed_at: new Date().toISOString(),
    }, { count: "exact" })
    .eq("organization_id", req.org!.id)
    .in("id", ids);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true, dismissed_count: count ?? 0 });
});

/** Calls Claude Haiku to translate a user's free-text dismissal reason into a
 *  concrete rule proposal. Returns null on parse failure or empty trigger;
 *  callers treat null as "no rule, log only". */
async function proposeRuleFromCustomDismiss(
  reasonText: string,
  taskDescription: string,
): Promise<{ trigger: string; rule_type: string; reason: string; confidence?: number } | null> {
  const system = `You translate a user's free-text reason for dismissing a smrtTask suggestion into a concrete rule we can store in rules_memory.

Return ONLY valid JSON, no prose, with this shape:
{ "trigger": "<concrete trigger>", "rule_type": "skip|skip_spam|bot|preference", "reason": "<short Hebrew explanation>", "confidence": 0.0-1.0 }

CORE PRINCIPLE — match the trigger's SCOPE to the user's reason:
  - If the reason names a TYPE of mail (login notifications, OTP codes,
    receipts, order confirmations, marketing, password resets, etc.) —
    use the NARROW subject_contains= trigger, even if the user also names
    a sender. The user is telling you *what kind* of mail to skip, not
    that the sender is unwanted overall.
  - Use from=/domain= only when the user clearly wants to block ALL
    mail from a sender, with no qualifier about which mails matter.
  - When in doubt, prefer the NARROWER trigger and lower confidence —
    the user can broaden it later, but a too-wide rule silently hides
    important mail and is hard to debug.

trigger conventions (pick the NARROWEST one that fits the user's reason):
  - "subject_contains=<text>"   block mails whose Subject contains <text>.
                                Use this whenever the user names a type
                                of mail (login, OTP, receipt, marketing,
                                shipping update, etc.). Single keyword
                                works best; pick an English token that
                                actually appears in such subjects.
  - "from=<email>"              block ALL mail from a specific sender.
                                Only use when the user said nothing about
                                what kind of mail — just "this sender".
  - "domain=<domain>"           block an entire company / domain.
  - "phone=<digits>"            block a WhatsApp phone.
  - "category=promotions|social|forums|updates"  Gmail category.
  - "topic=<keyword>"           topic preference (pair with rule_type=preference).
  - "keyword=<keyword>"         general keyword preference.

Examples (study these — they are the most common failure cases):
  Reason: "התראות כניסה מ-DualHook לא צריכות ליצור משימות"
    → { "trigger": "subject_contains=login", "rule_type": "skip",
        "reason": "התראות כניסה לא יוצרות משימות", "confidence": 0.85 }
    (NOT from=noreply@dualhook.com — the user named the TYPE, not the sender)

  Reason: "אישורי הזמנה מ-Amazon לא מעניינים אותי"
    → { "trigger": "subject_contains=order confirmation", "rule_type": "skip",
        "reason": "אישורי הזמנה לא יוצרים משימות", "confidence": 0.8 }

  Reason: "OTP / קודי אימות לא צריכים להיות משימה"
    → { "trigger": "subject_contains=OTP", "rule_type": "skip",
        "reason": "קודי אימות לא יוצרים משימות", "confidence": 0.85 }

  Reason: "אני לא רוצה לקבל יותר אימיילים מ-marketing@foo.com"
    → { "trigger": "from=marketing@foo.com", "rule_type": "skip",
        "reason": "חסימת שולח", "confidence": 0.9 }

  Reason: "כל מה שמגיע מ-newsletters.example.com"
    → { "trigger": "domain=newsletters.example.com", "rule_type": "skip",
        "reason": "חסימת דומיין", "confidence": 0.9 }

rule_type (must be exactly one of these — case-sensitive, no other values are accepted):
  - skip       — don't create tasks from this trigger
  - skip_spam  — same as skip but tagged as spam (for analytics)
  - bot        — known automated sender (WhatsApp phones, etc.)
  - preference — softer signal that should influence future classification but not auto-skip
                 (use this for topic/keyword triggers, not skip)

Confidence:
  - 0.85-0.95 when trigger scope matches the user's reason exactly
  - 0.6-0.75  when you had to broaden (e.g. user named a type but you used from=)
  - <0.5      when the reason is ambiguous and you're guessing

Only return a rule if you can extract something concrete from the user's reason. If the reason is too vague ("not important"), return { "trigger": "", "rule_type": "preference", "reason": "<echo>", "confidence": 0 } and we'll discard it.`;

  const userMsg = `User's reason: ${reasonText}\n\nDismissed task:\n${taskDescription}`;

  const { content } = await simpleCall("haiku", system, userMsg, 256);
  const parsed = parseJsonResponse<{ trigger: string; rule_type: string; reason: string; confidence?: number }>(content);
  if (!parsed || !parsed.trigger || !parsed.trigger.trim()) return null;

  // Must be a subset of RULE_MEMORY_RULE_TYPES (the rules_memory.rule_type
  // CHECK constraint, migration 20260424000001). We expose a narrower subset
  // to the model because the others ('action','style','financial') don't make
  // sense for "user dismissed a suggestion". An out-of-set value from the
  // model is discarded here — inserting it raw would fail the CHECK at runtime.
  const allowedTypes = new Set(["skip", "skip_spam", "bot", "preference"]);
  if (!allowedTypes.has(parsed.rule_type)) {
    console.error(`[proposeRuleFromCustomDismiss] model returned rule_type '${parsed.rule_type}' outside allowed subset — discarding proposal`);
    return null;
  }

  return {
    trigger: parsed.trigger.trim(),
    rule_type: parsed.rule_type,
    reason: parsed.reason?.trim() || "",
    confidence: parsed.confidence,
  };
}

/** Ask Claude Haiku to extract a short subject keyword that identifies the
 *  TYPE of mail represented by this message — used by the narrow-dismiss
 *  flow ("dismiss from this sender, only this type"). Returns the keyword
 *  plus a confidence. When confidence is below 0.6 the UI shows an empty
 *  field instead of a guess so the user types the keyword themselves. */
async function proposeSubjectKeyword(
  taskDescription: string,
  subject: string,
  bodyPreview: string,
): Promise<{ subject_keyword: string; confidence: number } | null> {
  const system = `You extract a short subject KEYWORD that identifies the *type* of email represented by this message — for use in a narrow skip rule "from this sender, only this type".

Return ONLY valid JSON, no prose, with this shape:
{ "subject_keyword": "<1-3 word keyword that appears in subjects of this type>", "confidence": 0.0-1.0 }

CORE PRINCIPLE — the keyword must identify the TYPE/TEMPLATE of the email, not the unique instance:
  - GOOD: "Deployment Failed" — identifies all Vercel deployment-failure alerts
  - BAD:  "Build #4537 failed for project foo" — that's THIS specific build, not the type
  - GOOD: "Invoice"           — identifies all invoices from a billing service
  - BAD:  "Invoice INV-2024-0042 for $1,250" — that's THIS specific invoice
  - GOOD: "Login alert"       — identifies all login notifications
  - GOOD: "Order shipped"     — identifies all shipping confirmations

Aim for 1-3 words. Prefer an English token if the subject is English; Hebrew if the subject is Hebrew. The keyword MUST be a substring that actually appears (case-insensitive) in subjects of this template — Gmail will match it as a substring at runtime.

Confidence:
  - 0.85-0.95 when the subject clearly follows a recognizable template
  - 0.6-0.8   when the type is plausible but the subject is generic
  - < 0.6     when there's no clear pattern — return whatever guess you have and let the UI surface that the user should confirm

If the subject is too generic to extract a useful keyword (e.g. "Notification", "Hello", a single name, empty), return { "subject_keyword": "", "confidence": 0 } and the UI will ask the user to type one.`;

  const userMsg = `Subject: ${subject}\n\nBody preview:\n${bodyPreview}\n\nTask context (what we created):\n${taskDescription}`;

  try {
    const { content } = await simpleCall("haiku", system, userMsg, 128);
    const parsed = parseJsonResponse<{ subject_keyword: string; confidence: number }>(content);
    if (!parsed) return null;
    // `&` is the trigger-clause separator. Strip it from any AI output so
    // the value can be safely composed into "from=X&subject_contains=Y"
    // and round-tripped through parseSkipRules.
    const keyword = (parsed.subject_keyword ?? "").replace(/&/g, "").trim();
    const conf = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return { subject_keyword: keyword, confidence: conf };
  } catch (e) {
    console.error("[proposeSubjectKeyword] failed:", e);
    return null;
  }
}

/** GET /tasks/:id/narrow-dismiss-propose
 *  AI-suggested subject keyword for the "dismiss from this sender, only this
 *  type" flow. Returns the proposed keyword + cascade preview filtered on
 *  same-sender AND subject contains the keyword. The UI shows the keyword
 *  in an editable input so the user can correct a bad guess before
 *  committing to a rule.
 */
router.get("/tasks/:id/narrow-dismiss-propose", requireFullTask, async (req: Request, res: Response) => {
  const { data: task, error: tErr } = await db
    .from("tasks")
    .select("id, user_id, title_he, title, description, related_contact, source_message_id, source_messages(source_type, sender_email, sender_phone, sender, subject, body_text)")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (tErr) return res.status(500).json({ error: tErr.message });
  if (!task) return res.status(404).json({ error: "task not found in this org" });
  if (!task.source_message_id) return res.status(400).json({ error: "task has no linked source message" });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smRaw = (task as any).source_messages;
  const sm = (Array.isArray(smRaw) ? smRaw[0] : smRaw) as {
    source_type?: string | null; sender_email?: string | null; sender_phone?: string | null;
    sender?: string | null; subject?: string | null; body_text?: string | null;
  } | null;

  // Narrow dismiss is Gmail-only. WhatsApp/Calendar messages have no subject
  // so a "subject_contains=" clause can't be paired with the sender filter.
  if (!sm || (sm.source_type !== "gmail" && sm.source_type !== "gmail_sent")) {
    return res.status(400).json({ error: "narrow dismiss is only available for email suggestions" });
  }

  const sender = resolveSender(sm, "sender_unimportant");
  if (!sender) return res.status(400).json({ error: "could not resolve sender" });

  // Ask Claude for a keyword. The proposer can fail (network, rate limit)
  // or return an empty keyword for generic subjects — both end with the UI
  // showing an empty editable field and letting the user type one in.
  const taskDesc = [
    `Task: ${task.title_he ?? task.title ?? ""}`,
    task.description ? `Description: ${task.description}` : "",
    task.related_contact ? `Contact: ${task.related_contact}` : "",
  ].filter(Boolean).join("\n");
  const bodyPreview = (sm.body_text ?? "").slice(0, 1200);
  const proposal = await proposeSubjectKeyword(taskDesc, sm.subject ?? "", bodyPreview);

  const proposed = proposal && proposal.confidence >= 0.6 ? proposal.subject_keyword : "";

  // Cascade preview: count OTHER pending suggestions from the same sender
  // whose source_message.subject contains the proposed keyword. When the
  // keyword is empty (low confidence / generic subject) we fall back to a
  // sender-only count so the dialog still shows something meaningful.
  let cascadeCount = 0;
  const composedTrigger = proposed
    ? `${sender.trigger}&subject_contains=${proposed}`
    : sender.trigger;
  {
    const { data: matchingSms } = await db
      .from("source_messages")
      .select("id, subject")
      .eq("user_id", task.user_id)
      .eq(sender.filterCol, sender.filterVal);
    const filtered = (matchingSms ?? [])
      .filter((r) => r.id !== task.source_message_id)
      .filter((r) => !proposed || (r.subject ?? "").toLowerCase().includes(proposed.toLowerCase()));
    const smIds = filtered.map((r) => r.id);
    if (smIds.length > 0) {
      const { count } = await db
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", req.org!.id)
        .eq("status", "inbox")
        .in("source_message_id", smIds);
      cascadeCount = count ?? 0;
    }
  }

  res.json({
    subject_keyword: proposed,
    sender_trigger: sender.trigger,
    composed_trigger: composedTrigger,
    cascade_count: cascadeCount,
    // Used by the UI to decide whether to pre-fill or prompt for entry.
    has_proposal: proposed.length > 0,
  });
});

export default router;
