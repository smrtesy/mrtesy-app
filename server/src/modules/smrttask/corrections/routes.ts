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

const router = Router();

// Every correction route requires auth + active org + smrtTask enabled.
router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

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
    context: body.context && typeof body.context === "object" ? body.context : {},
  };

  const { data, error } = await db
    .from("task_corrections")
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ correction: data });
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
