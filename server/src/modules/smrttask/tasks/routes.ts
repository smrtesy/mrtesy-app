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
import { simpleCall, parseJsonResponse } from "../../../anthropic";

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
  "ai_generated_content", "linked_drive_docs", "checklist", "task_materials",
  // Follow-up signals from ai-process (clearing when user reads the task)
  "has_unread_update", "completion_signal_detected", "completion_signal_reason",
]);

const STATUSES = ["inbox", "in_progress", "snoozed", "archived", "completed", "pending_completion"];
const PRIORITIES = ["urgent", "high", "medium", "low"];

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

  const safeName = filename.replace(/[/\\]+/g, "_").slice(0, 200);
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
    filename:  safeName,
  });
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
      .select("classification_reason, ai_classification, ai_model_used, ai_input_tokens, ai_output_tokens, ai_cost_usd, status, error_message, created_at")
      .eq("source_message_id", task.source_message_id)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  res.json({
    source: sm ?? null,
    log:    logs?.[0] ?? null,
  });
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
  "spam",
  "custom",
]);

const CASCADING_CODES = new Set(["sender_unimportant", "spam"]);

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
router.get("/tasks/:id/dismiss-preview", async (req: Request, res: Response) => {
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
router.post("/tasks/:id/dismiss", async (req: Request, res: Response) => {
  const reasonCode = (req.body?.reason_code ?? "") as string;
  const reasonText = typeof req.body?.reason_text === "string" ? req.body.reason_text.trim() : "";
  const cascadeRequested = req.body?.cascade !== false;  // default true; pass false to opt out

  if (!DISMISSAL_CODES.has(reasonCode)) {
    return res.status(400).json({ error: "invalid reason_code" });
  }
  if (reasonCode === "custom" && !reasonText) {
    return res.status(400).json({ error: "reason_text is required when reason_code='custom'" });
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

  // Archive + record reason
  const now = new Date().toISOString();
  const dismissPatch = {
    status: "archived",
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

  // 1. rules_memory — block the sender for future syncs.
  let ruleCreated: { id: string; trigger: string; rule_type: string } | null = null;
  if (sender) {
    const { data: rule, error: rErr } = await db
      .from("rules_memory")
      .insert({
        user_id: task.user_id,
        app_slug: "smrttask",
        trigger:    sender.trigger,
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

  // 2. Cascade — archive every OTHER pending suggestion from the same sender.
  //    Skipped when cascade=false in body (the dialog's "סגור גם N אחרות" checkbox).
  let cascadedCount = 0;
  if (sender && cascadeRequested) {
    const { data: matchingSms } = await db
      .from("source_messages")
      .select("id")
      .eq("user_id", task.user_id)
      .eq(sender.filterCol, sender.filterVal);
    const smIds = (matchingSms ?? []).map((r) => r.id).filter((id) => id !== task.source_message_id);

    if (smIds.length > 0) {
      const { count, error: cErr } = await db
        .from("tasks")
        .update(dismissPatch, { count: "exact" })
        .eq("organization_id", req.org!.id)
        .eq("status", "inbox")
        .in("source_message_id", smIds);
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
        const conf = typeof proposal.confidence === "number"
          ? Math.max(0, Math.min(1, proposal.confidence))
          : 0.6;
        const { data: pendingRow, error: pErr } = await db
          .from("rules_memory")
          .insert({
            user_id: task.user_id,
            app_slug: "smrttask",
            trigger:    proposal.trigger,
            rule_type:  proposal.rule_type,
            action:     proposal.rule_type === "skip" || proposal.rule_type === "skip_spam" ? "skip" : null,
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
router.post("/tasks/:id/dismiss-fast", async (req: Request, res: Response) => {
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
      status: "archived",
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
router.post("/tasks/bulk-approve", async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.task_ids) ? (req.body.task_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return res.status(400).json({ error: "task_ids required" });

  const now = new Date().toISOString();
  const { count, error } = await db
    .from("tasks")
    .update({ manually_verified: true, seen_at: now }, { count: "exact" })
    .eq("organization_id", req.org!.id)
    .in("id", ids);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ ok: true, approved_count: count ?? 0 });
});

/** POST /tasks/bulk-dismiss-fast
 *  Body: { task_ids: string[] }
 *  Same semantics as dismiss-fast but for a batch — archives without
 *  learning, cascading, or LLM calls. */
router.post("/tasks/bulk-dismiss-fast", async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.task_ids) ? (req.body.task_ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
  if (ids.length === 0) return res.status(400).json({ error: "task_ids required" });

  const { count, error } = await db
    .from("tasks")
    .update({
      status: "archived",
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

  // Must match rules_memory.rule_type CHECK constraint:
  // ('skip','skip_spam','action','style','bot','preference','financial')
  // We expose a narrower subset to the model because the others don't make sense
  // for "user dismissed a suggestion".
  const allowedTypes = new Set(["skip", "skip_spam", "bot", "preference"]);
  if (!allowedTypes.has(parsed.rule_type)) return null;

  return {
    trigger: parsed.trigger.trim(),
    rule_type: parsed.rule_type,
    reason: parsed.reason?.trim() || "",
    confidence: parsed.confidence,
  };
}

export default router;
