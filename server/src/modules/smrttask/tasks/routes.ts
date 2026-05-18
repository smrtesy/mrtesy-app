/**
 * Task routes — base module (no AI required; every app gets these).
 * All routes require X-Org-Id and scope every query to the active org.
 *
 *   GET    /tasks                       list (with filters)
 *   GET    /tasks/:id                   single (with project + source_message joins)
 *   POST   /tasks                       create (manual task)
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
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { emitEvent } from "../../../lib/platform";

const router = Router();

// Every task route requires auth + active org + smrtTask enabled for that org.
router.use(requireAuth, requireOrg, requireApp("smrttask"));

// ── fields whitelisted for PATCH ───────────────────────────────────────────
const UPDATABLE_FIELDS = new Set([
  "title", "title_he", "description", "priority", "status",
  "due_date", "due_time", "tags", "related_contact",
  "related_contact_email", "related_contact_phone",
  "project_id", "project_confidence", "assigned_to_user_id",
  "manually_verified", "source_link",
  // JSON content fields — client sends the whole array after read-modify-write
  "ai_generated_content", "linked_drive_docs",
]);

const STATUSES = ["inbox", "in_progress", "snoozed", "archived", "completed"];
const PRIORITIES = ["urgent", "high", "medium", "low"];

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
  q: T, query: Request["query"],
): T {
  const { status, verified, project_id, assigned_to, has_source, task_type } = query;
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
  return q;
}

/** GET /tasks?status=inbox&verified=true&project_id=...&assigned_to=...&has_source=true&task_type=action&limit=50 */
router.get("/tasks", async (req: Request, res: Response) => {
  const { limit } = req.query;

  let q = db
    .from("tasks")
    .select("*, source_messages(source_type, source_url, serial_display), projects(id, name, name_he, color)")
    .eq("organization_id", req.org!.id);

  q = applyTaskFilters(q, req.query);
  q = q.order("created_at", { ascending: false });
  const n = Math.min(parseInt((limit as string) ?? "50", 10) || 50, 200);
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
  q = applyTaskFilters(q, req.query);

  const { count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ count: count ?? 0 });
});

/** GET /tasks/:id */
router.get("/tasks/:id", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("tasks")
    .select("*, source_messages(source_type, source_url, serial_display), projects(id, name, name_he, color)")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "task not found" });
  res.json({ task: data });
});

/** POST /tasks — create manual task */
router.post("/tasks", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.title || typeof body.title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  let updates: Record<string, unknown>;
  try { updates = pickUpdates(body); }
  catch (e) { return res.status(400).json({ error: (e as Error).message }); }

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
    .select("*, source_messages(source_type, source_url, serial_display), projects(id, name, name_he, color)")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  await emitEvent(req.org!.id, "smrttask", "task.created", "task", data.id, {
    title: data.title,
    priority: data.priority,
  });

  res.status(201).json({ task: data });
});

/** PATCH /tasks/:id */
router.patch("/tasks/:id", async (req: Request, res: Response) => {
  let updates: Record<string, unknown>;
  try { updates = pickUpdates(req.body ?? {}); }
  catch (e) { return res.status(400).json({ error: (e as Error).message }); }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  // Track status_changed_at
  if (updates.status) updates.status_changed_at = new Date().toISOString();
  updates.updated_at = new Date().toISOString();

  const { data, error } = await db
    .from("tasks")
    .update(updates)
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("*, source_messages(source_type, source_url, serial_display), projects(id, name, name_he, color)")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "task not found in this org" });
  res.json({ task: data });
});

/** DELETE /tasks/:id */
router.delete("/tasks/:id", async (req: Request, res: Response) => {
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
  const { data, error } = await db
    .from("tasks")
    .update({ status: "archived", completed_at: now, status_changed_at: now })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("id, status, completed_at")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "task not found in this org" });

  await emitEvent(req.org!.id, "smrttask", "task.completed", "task", data.id, {
    completed_at: data.completed_at,
  });

  res.json({ task: data });
});

/** POST /tasks/:id/snooze */
router.post("/tasks/:id/snooze", async (req: Request, res: Response) => {
  // Default: tomorrow at 9am. Body can pass { until: ISO } to override.
  let until: string;
  if (req.body?.until && typeof req.body.until === "string") {
    until = req.body.until;
  } else {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(9, 0, 0, 0);
    until = t.toISOString();
  }

  // Bump snooze_count atomically via a fresh read+write — Postgres has no `+1` shorthand here.
  const { data: current } = await db
    .from("tasks")
    .select("snooze_count")
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .maybeSingle();
  if (!current) return res.status(404).json({ error: "task not found in this org" });

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

/** POST /tasks/:id/seen */
router.post("/tasks/:id/seen", async (req: Request, res: Response) => {
  const { error } = await db
    .from("tasks")
    .update({ seen_at: new Date().toISOString() })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/** POST /tasks/:id/updates — append a manual note to updates[] */
router.post("/tasks/:id/updates", async (req: Request, res: Response) => {
  const { content, type = "note" } = req.body ?? {};
  if (!content || typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }

  const { data: current } = await db
    .from("tasks")
    .select("updates")
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
  res.status(201).json({ update: entry });
});

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
  async (req: Request, res: Response) => {
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

export default router;
