/**
 * Organization knowledge base — shared Q&A library that the AI draft pipeline
 * reuses across the whole org.
 *
 * Read is open to every org member; adding is open to every member but lands as
 * a SUGGESTION (status='pending') unless an org manager (owner/admin) creates it
 * — managers' entries are auto-approved. Approving / rejecting / editing /
 * deleting is manager-only. Only 'approved' entries are ever fed to the model
 * (see match_knowledge_base_org).
 *
 * Routes (mounted at /api/knowledge):
 *   GET    /                 list org entries (?status=pending|approved|rejected)
 *   POST   /save             save an approved task draft as a Q&A (from QuickAction)
 *   POST   /                 manual add { question, answer, language? }
 *   PATCH  /:id              edit { question?, answer? }            (manager)
 *   POST   /:id/approve      approve a pending suggestion           (manager)
 *   POST   /:id/reject       reject a pending suggestion            (manager)
 *   DELETE /:id              delete (manager, or author of own entry)
 */

import { Router, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireRole } from "../../../middleware/require-role";
import { saveKnowledge } from "../../../lib/knowledge";
import { embedText } from "../../../services/voyage";

const router = Router();

router.use(requireAuth, requireOrg, requireApp("smrttask"));

function isManager(req: Request): boolean {
  return req.member?.role === "owner" || req.member?.role === "admin";
}

const LIST_FIELDS =
  "id, question, answer, status, source_type, language, task_id, created_by, approved_by, approved_at, created_at";

/** GET /knowledge?status=pending — list this org's entries, newest first. */
router.get("/", async (req: Request, res: Response) => {
  let q = db
    .from("knowledge_base")
    .select(LIST_FIELDS)
    .eq("organization_id", req.org!.id)
    .order("created_at", { ascending: false })
    .limit(500);

  const status = req.query.status;
  if (status === "pending" || status === "approved" || status === "rejected") {
    q = q.eq("status", status);
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  // role lets the client decide which controls to show; the server still
  // enforces manager-only actions via requireRole regardless of what the UI does.
  res.json({ entries: data ?? [], role: req.member!.role, user_id: req.user!.id });
});

/**
 * POST /knowledge/save — save an approved answer from a task draft.
 * Body: { task_id, answer }. The question is reconstructed from the task +
 * its source message. Members' saves land as pending; managers' auto-approve.
 */
router.post("/save", async (req: Request, res: Response) => {
  const { task_id, answer } = req.body ?? {};
  if (!task_id || typeof answer !== "string" || !answer.trim()) {
    return res.status(400).json({ error: "task_id and answer required" });
  }

  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("title, title_he, source_message_id")
    .eq("id", task_id)
    .eq("organization_id", req.org!.id)
    .maybeSingle();

  if (taskErr || !task) return res.status(404).json({ error: "Task not found" });

  const { data: sourceMsg } = task.source_message_id
    ? await db
        .from("source_messages")
        .select("raw_content, body_text, source_type")
        .eq("id", task.source_message_id)
        .maybeSingle()
    : { data: null };

  const original = sourceMsg?.raw_content ?? sourceMsg?.body_text ?? "";
  const question = `${task.title_he ?? task.title}\n${original}`.trim();

  const result = await saveKnowledge({
    userId: req.user!.id,
    organizationId: req.org!.id,
    question,
    answer,
    status: isManager(req) ? "approved" : "pending",
    createdBy: req.user!.id,
    sourceType: sourceMsg?.source_type ?? null,
    taskId: task_id,
  });

  if ("error" in result) {
    const status = result.error === "embedding_unavailable" ? 503 : 500;
    return res.status(status).json({ error: result.error });
  }
  res.json({ id: result.id, ok: true, status: isManager(req) ? "approved" : "pending" });
});

/** POST /knowledge — manual add. Body: { question, answer, language? } */
router.post("/", async (req: Request, res: Response) => {
  const { question, answer, language } = req.body ?? {};
  if (typeof question !== "string" || !question.trim() || typeof answer !== "string" || !answer.trim()) {
    return res.status(400).json({ error: "question and answer required" });
  }

  const result = await saveKnowledge({
    userId: req.user!.id,
    organizationId: req.org!.id,
    question,
    answer,
    status: isManager(req) ? "approved" : "pending",
    createdBy: req.user!.id,
    sourceType: "manual",
    language: typeof language === "string" ? language : null,
  });

  if ("error" in result) {
    const status = result.error === "embedding_unavailable" ? 503 : 500;
    return res.status(status).json({ error: result.error });
  }
  res.status(201).json({ id: result.id, ok: true, status: isManager(req) ? "approved" : "pending" });
});

/** PATCH /knowledge/:id — edit question/answer (manager only). Re-embeds on question change. */
router.patch("/:id", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const { question, answer } = req.body ?? {};
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (typeof answer === "string" && answer.trim()) updates.answer = answer.trim();

  if (typeof question === "string" && question.trim()) {
    const q = question.trim();
    updates.question = q;
    // Re-embed so semantic lookup tracks the edited question. If Voyage is
    // unavailable we null the embedding (lookup skips NULLs) rather than keep a
    // stale vector that no longer matches the text.
    const embedding = await embedText(q, "document", { userId: req.user!.id, refId: req.params.id });
    updates.embedding = embedding ? JSON.stringify(embedding) : null;
  }

  if (!("answer" in updates) && !("question" in updates)) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("knowledge_base")
    .update(updates)
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id)
    .select("id")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "entry not found in this org" });
  res.json({ ok: true });
});

/** POST /knowledge/:id/approve — manager only. */
router.post("/:id/approve", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("knowledge_base")
    .update({
      status: "approved",
      approved_by: req.user!.id,
      approved_at: new Date().toISOString(),
    })
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id)
    .select("id")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "entry not found in this org" });
  res.json({ ok: true, status: "approved" });
});

/** POST /knowledge/:id/reject — manager only. */
router.post("/:id/reject", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("knowledge_base")
    .update({ status: "rejected", approved_by: null, approved_at: null })
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id)
    .select("id")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "entry not found in this org" });
  res.json({ ok: true, status: "rejected" });
});

/**
 * DELETE /knowledge/:id — managers may delete any org entry; a non-manager may
 * delete only their own entry (e.g. withdraw a suggestion they made).
 */
router.delete("/:id", async (req: Request, res: Response) => {
  let q = db
    .from("knowledge_base")
    .delete({ count: "exact" })
    .eq("id", req.params.id)
    .eq("organization_id", req.org!.id);

  if (!isManager(req)) q = q.eq("created_by", req.user!.id);

  const { error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "entry not found or not yours" });
  res.json({ ok: true });
});

export default router;
