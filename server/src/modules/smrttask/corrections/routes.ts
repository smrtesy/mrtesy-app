/**
 * Correction routes — user-authored fixes/feedback on smrtTask log entries.
 *
 *   GET    /corrections                 list (with ?scope & ?exported filters + counts)
 *   POST   /corrections                 create a correction (note + scope + context)
 *   POST   /corrections/export          generate a comprehensive JSON export and
 *                                       mark the included corrections as exported
 *   GET    /corrections/exports         list past export batches
 *
 * Scope semantics:
 *   • 'general'  — true for all users → belongs in the shared rules/prompt.
 *   • 'personal' — applies only to this user → becomes a per-user rule.
 *
 * The export marks rows with exported_at + export_batch_id so the user always
 * knows what has already been handed to Claude Code and what is still new.
 * Corrections are user-owned; every query is scoped to req.user.id.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireFullTask } from "../lib/access";
import { triageCorrection, PROMPT_CLASSES, type PromptClass } from "./triage";
import { createFixThread, autofixEnabled } from "./execute";

const router = Router();

// Every correction route requires auth + active org + smrtTask enabled.
router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

/**
 * Strip the server-owned keys out of a client-supplied `context`. `prompt_class`
 * and `triage` decide whether a correction reaches the classifier prompt, so
 * they are written by triage and by the decision endpoint only — never by the
 * request that creates the correction.
 */
function sanitizeClientContext(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { prompt_class: _pc, triage: _t, ...rest } = raw as Record<string, unknown>;
  return rest;
}

const SCOPES = ["general", "personal"] as const;
const CORRECTION_TYPES = ["reclassify", "status", "note", "other"] as const;

/** GET /corrections?scope=all|general|personal&exported=all|pending|exported&limit=200 */
router.get("/corrections", async (req: Request, res: Response) => {
  const { scope, exported, limit } = req.query;

  let q = db
    .from("task_corrections")
    .select("*")
    .eq("user_id", req.user!.id)
    .eq("app_slug", "smrttask")
    .order("created_at", { ascending: false });

  if (scope === "general" || scope === "personal") q = q.eq("scope", scope);
  if (exported === "pending") q = q.is("exported_at", null);
  if (exported === "exported") q = q.not("exported_at", "is", null);

  const n = Math.min(parseInt((limit as string) ?? "200", 10) || 200, 1000);
  q = q.limit(n);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Pending counts give the UI a live "X new corrections to export" badge.
  const { data: pendingRows, error: pErr } = await db
    .from("task_corrections")
    .select("scope")
    .eq("user_id", req.user!.id)
    .eq("app_slug", "smrttask")
    .is("exported_at", null);
  if (pErr) return res.status(500).json({ error: pErr.message });

  const pending = { all: 0, general: 0, personal: 0 };
  for (const r of pendingRows ?? []) {
    pending.all += 1;
    if (r.scope === "general") pending.general += 1;
    else if (r.scope === "personal") pending.personal += 1;
  }

  res.json({ corrections: data ?? [], pending });
});

/** POST /corrections — create one correction. */
router.post("/corrections", async (req: Request, res: Response) => {
  const body = req.body ?? {};

  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (!note) return res.status(400).json({ error: "note is required" });

  const scope = body.scope;
  if (!SCOPES.includes(scope)) {
    return res.status(400).json({ error: `scope must be one of ${SCOPES.join(", ")}` });
  }

  const correction_type = CORRECTION_TYPES.includes(body.correction_type)
    ? body.correction_type
    : "note";

  const payload = {
    user_id: req.user!.id,
    organization_id: req.org!.id,
    app_slug: "smrttask",
    source_message_id: body.source_message_id ?? null,
    task_id: body.task_id ?? null,
    log_entry_id: body.log_entry_id ?? null,
    correction_type,
    field: typeof body.field === "string" ? body.field : null,
    old_value: body.old_value != null ? String(body.old_value) : null,
    new_value: body.new_value != null ? String(body.new_value) : null,
    note,
    scope,
    // The client may attach context, but NOT the triage verdict. Left open, a
    // caller could POST {prompt_class:"prompt", triage:{approved:true}} and put
    // arbitrary text into their own classifier prompt with no triage and no
    // approval — the two gates this whole flow exists to impose. Scope is
    // per-user so it reached no one else, but self-injection still defeats the
    // point. These keys are owned by the server from here on.
    context: sanitizeClientContext(body.context),
  };

  const { data, error } = await db
    .from("task_corrections")
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Triage runs on the Claude Code CLI (subscription, zero paid API tokens) and
  // takes tens of seconds, so it is deliberately NOT awaited: the user gets their
  // 201 immediately and the verdict arrives as an inbox notification. Detached on
  // purpose — a triage failure must never turn into a failed correction. Nothing
  // it decides reaches the classifier without the approval step below.
  void triageCorrection(data.id as string);

  res.status(201).json({ correction: data });
});

/**
 * POST /corrections/:id/decision — the approval step.
 * body: { decision: "approve" | "reject", prompt_class?: PromptClass, rule?: string }
 *
 * Only an APPROVED correction whose class is "prompt" is ever injected into the
 * classifier prompt (ai-process uses an allow-list). "approve" on any other class
 * records the user's agreement with the triage without granting prompt access, so
 * approving a "code" verdict cannot accidentally start steering classification.
 *
 * The user may also override the class outright — triage proposes, the user
 * decides, and an override is recorded as theirs rather than silently replacing
 * the machine verdict.
 */
router.post("/corrections/:id/decision", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const body = req.body ?? {};
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) return res.status(400).json({ error: "decision must be approve or reject" });

  const { data: existing, error: findErr } = await db
    .from("task_corrections")
    .select("id, context, note, task_id, source_message_id, organization_id")
    .eq("id", id)
    .eq("user_id", req.user!.id)
    .eq("app_slug", "smrttask")
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!existing) return res.status(404).json({ error: "not_found" });

  const prev = (existing.context ?? {}) as Record<string, unknown>;
  const prevTriage = (prev.triage ?? {}) as Record<string, unknown>;

  const overrideClass =
    typeof body.prompt_class === "string" && PROMPT_CLASSES.includes(body.prompt_class as PromptClass)
      ? (body.prompt_class as PromptClass)
      : null;
  const finalClass = overrideClass ?? (prev.prompt_class as PromptClass | undefined) ?? "unclear";

  // An approved rule can be reworded on the way in — the user's wording wins over
  // the suggestion, and the note itself is never rewritten.
  const rule =
    typeof body.rule === "string" && body.rule.trim()
      ? body.rule.trim().slice(0, 400)
      : (prevTriage.suggested_rule_he as string | null | undefined) ?? null;

  // Slice 4 — approving a code/ui correction spawns a fix thread that implements
  // it and opens a PR (never merges). Dark unless SMRTTASK_CORRECTIONS_AUTOFIX=1,
  // so by default this block is a no-op and approval behaves exactly as before.
  let fixThreadId: string | null = null;
  if (decision === "approve" && (finalClass === "code" || finalClass === "ui") && autofixEnabled()) {
    let serial: string | null = null;
    let taskTitle: string | null = null;
    if (existing.task_id) {
      const { data: task } = await db
        .from("tasks")
        .select("serial_display, title_he")
        .eq("id", existing.task_id as string)
        .maybeSingle();
      serial = (task?.serial_display as string | null) ?? null;
      taskTitle = (task?.title_he as string | null) ?? null;
    }
    let msgSubject: string | null = null;
    let msgSender: string | null = null;
    if (existing.source_message_id) {
      const { data: sm } = await db
        .from("source_messages")
        .select("subject, sender, sender_email")
        .eq("id", existing.source_message_id as string)
        .maybeSingle();
      msgSubject = (sm?.subject as string | null) ?? null;
      msgSender = ((sm?.sender ?? sm?.sender_email) as string | null) ?? null;
    }
    fixThreadId = await createFixThread(
      id,
      finalClass,
      (existing.organization_id as string) ?? req.org!.id,
      req.user!.id,
      {
        note: String(existing.note ?? ""),
        understood_he: (prevTriage.understood_he as string | null) ?? null,
        reason_he: (prevTriage.reason_he as string | null) ?? null,
        serial,
        task_title: taskTitle,
        msg_subject: msgSubject,
        msg_sender: msgSender,
      },
    );
  }

  const context = {
    ...prev,
    prompt_class: finalClass,
    triage: {
      ...prevTriage,
      suggested_rule_he: rule,
      approved: decision === "approve",
      decided_at: new Date().toISOString(),
      decided_by: "user",
      class_overridden_by_user: overrideClass !== null,
    },
    ...(fixThreadId
      ? { execution: { thread_id: fixThreadId, at: new Date().toISOString() } }
      : {}),
  };

  const { data, error } = await db
    .from("task_corrections")
    .update({ context, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", req.user!.id)
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ correction: data, fix_thread_id: fixThreadId });
});

/**
 * POST /corrections/export
 * body: { scope?: 'all'|'general'|'personal', onlyUnexported?: boolean (default true) }
 *
 * Returns the most comprehensive JSON payload we have for each correction and,
 * for the rows that were not yet exported, stamps them with this batch so the
 * user can see what is new vs. already handed off.
 */
router.post("/corrections/export", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const scope: "all" | "general" | "personal" =
    body.scope === "general" || body.scope === "personal" ? body.scope : "all";
  const onlyUnexported = body.onlyUnexported !== false; // default true

  let q = db
    .from("task_corrections")
    .select("*")
    .eq("user_id", req.user!.id)
    .eq("app_slug", "smrttask")
    .order("created_at", { ascending: true });

  if (scope !== "all") q = q.eq("scope", scope);
  if (onlyUnexported) q = q.is("exported_at", null);

  const { data: rows, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  const corrections = rows ?? [];

  // Record the export batch first so we can stamp the rows with its id.
  const { data: batch, error: bErr } = await db
    .from("correction_exports")
    .insert({
      user_id: req.user!.id,
      organization_id: req.org!.id,
      app_slug: "smrttask",
      scope_filter: scope,
      correction_count: corrections.length,
    })
    .select("*")
    .single();
  if (bErr) return res.status(500).json({ error: bErr.message });

  // Stamp the not-yet-exported rows from this batch. (Already-exported rows that
  // get re-included keep their original exported_at/export_batch_id.)
  const freshIds = corrections.filter((c) => !c.exported_at).map((c) => c.id);
  if (freshIds.length > 0) {
    const { error: uErr } = await db
      .from("task_corrections")
      .update({ exported_at: batch.created_at, export_batch_id: batch.id, updated_at: new Date().toISOString() })
      .in("id", freshIds);
    if (uErr) return res.status(500).json({ error: uErr.message });
  }

  const general = corrections.filter((c) => c.scope === "general");
  const personal = corrections.filter((c) => c.scope === "personal");

  // The export envelope is deliberately self-describing: a human or Claude Code
  // can read it without any external schema. `instructions` explains exactly
  // what to do with each scope.
  const payload = {
    export_format: "smrttask.corrections.v1",
    generated_at: batch.created_at,
    export_batch_id: batch.id,
    app_slug: "smrttask",
    user: { id: req.user!.id, email: req.user!.email ?? null },
    organization_id: req.org!.id,
    filter: { scope, only_unexported: onlyUnexported },
    counts: { total: corrections.length, general: general.length, personal: personal.length },
    instructions: {
      he:
        "קובץ זה מכיל תיקונים שהמשתמש סימן בלוג של smrtTask. " +
        "תיקונים בהיקף 'general' נכונים לכל המשתמשים — הטמע אותם בפרומפט/כללים הגלובליים של המסווג. " +
        "תיקונים בהיקף 'personal' חלים רק על המשתמש הזה — הוסף אותם ככלל אישי למשתמש (user_id למעלה). " +
        "כל תיקון כולל את ההסבר (note), הסיווג הישן/חדש, וצילום מצב מלא של המקור (context).",
      en:
        "This file contains corrections the user flagged in the smrtTask log. " +
        "'general' corrections are true for all users — bake them into the global classifier prompt/rules. " +
        "'personal' corrections apply only to this user — add them as a per-user rule (see user.id above). " +
        "Each correction includes the explanation (note), the old/new classification, and a full snapshot of the source (context).",
    },
    corrections: corrections.map((c) => ({
      id: c.id,
      created_at: c.created_at,
      scope: c.scope,
      correction_type: c.correction_type,
      note: c.note,
      change: { field: c.field, from: c.old_value, to: c.new_value },
      source_message_id: c.source_message_id,
      task_id: c.task_id,
      log_entry_id: c.log_entry_id,
      context: c.context ?? {},
      previously_exported: !!c.exported_at,
    })),
  };

  res.json({ export: payload, batch });
});

/**
 * POST /corrections/:id/claude-thread — "continue with Claude".
 *
 * Human-initiated (a tap), so it is NOT gated by SMRTTASK_CORRECTIONS_AUTOFIX:
 * opening a Claude conversation on your own correction is exactly what the task
 * ClaudeLauncher already does. Creates a fix thread seeded with the correction's
 * context and starts it, then returns the thread id so the client can open it.
 */
router.post("/corrections/:id/claude-thread", async (req: Request, res: Response) => {
  const id = String(req.params.id ?? "");
  const { data: c, error: findErr } = await db
    .from("task_corrections")
    .select("id, context, note, task_id, source_message_id, organization_id")
    .eq("id", id)
    .eq("user_id", req.user!.id)
    .eq("app_slug", "smrttask")
    .maybeSingle();
  if (findErr) return res.status(500).json({ error: findErr.message });
  if (!c) return res.status(404).json({ error: "not_found" });

  const ctx = (c.context ?? {}) as Record<string, unknown>;
  const tri = (ctx.triage ?? {}) as Record<string, unknown>;
  const cls: "code" | "ui" = ctx.prompt_class === "ui" ? "ui" : "code";

  let serial: string | null = null;
  let taskTitle: string | null = null;
  if (c.task_id) {
    const { data: task } = await db
      .from("tasks")
      .select("serial_display, title_he")
      .eq("id", c.task_id as string)
      .maybeSingle();
    serial = (task?.serial_display as string | null) ?? null;
    taskTitle = (task?.title_he as string | null) ?? null;
  }
  let msgSubject: string | null = null;
  let msgSender: string | null = null;
  if (c.source_message_id) {
    const { data: sm } = await db
      .from("source_messages")
      .select("subject, sender, sender_email")
      .eq("id", c.source_message_id as string)
      .maybeSingle();
    msgSubject = (sm?.subject as string | null) ?? null;
    msgSender = ((sm?.sender ?? sm?.sender_email) as string | null) ?? null;
  }

  const threadId = await createFixThread(
    id,
    cls,
    (c.organization_id as string) ?? req.org!.id,
    req.user!.id,
    {
      note: String(c.note ?? ""),
      understood_he: (tri.understood_he as string | null) ?? null,
      reason_he: (tri.reason_he as string | null) ?? null,
      serial,
      task_title: taskTitle,
      msg_subject: msgSubject,
      msg_sender: msgSender,
    },
    { force: true },
  );
  if (!threadId) return res.status(500).json({ error: "could not open thread" });

  // Record the link so the correction and its Claude conversation stay tied.
  const nextContext = { ...ctx, execution: { thread_id: threadId, at: new Date().toISOString() } };
  await db
    .from("task_corrections")
    .update({ context: nextContext, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", req.user!.id);

  res.status(201).json({ thread_id: threadId });
});

/** GET /corrections/exports — history of export batches. */
router.get("/corrections/exports", async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("correction_exports")
    .select("*")
    .eq("user_id", req.user!.id)
    .eq("app_slug", "smrttask")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ exports: data ?? [] });
});

export default router;
