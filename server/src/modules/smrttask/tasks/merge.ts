/**
 * Task merge — unify N suggestions/tasks into a single target task.
 *
 *   POST /tasks/merge/propose   → Sonnet 4.6 reads all sources and proposes
 *                                  a merged title/description/checklist/etc.
 *                                  Pure compute, no DB writes.
 *   POST /tasks/merge           → execute the merge atomically (RPC).
 *   POST /tasks/merge/undo      → reverse a merge by id.
 *
 * See `supabase/migrations/20260528150000_task_merges.sql` and
 * `..._merge_tasks_function.sql` for the DB layer.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { simpleCall, parseJsonResponse } from "../../../anthropic";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrttask"));

// ── types ──────────────────────────────────────────────────────────────────

const MERGE_KINDS = new Set([
  "suggestion_into_existing",
  "suggestions_into_new",
  "tasks_into_new",
  "ai_proposed",
]);

interface ProposeBody {
  source_task_ids: string[];
  /** When provided, the AI is told the user picked this task as the target
   *  and should treat its existing content as the spine that the others
   *  augment, rather than synthesizing a brand new title. */
  target_task_id?: string;
}

interface MergeBody {
  source_task_ids: string[];
  target:
    | { mode: "existing"; task_id: string }
    | {
        mode: "new";
        title: string;
        title_he?: string;
        description?: string | null;
        due_date?: string | null;
        due_time?: string | null;
        priority?: "urgent" | "high" | "medium" | "low";
        checklist?: ChecklistItem[];
        tags?: string[];
        source_link?: string | null;
        project_id?: string | null;
      };
  /** Partial UPDATE for an existing target. Only meaningful when target.mode='existing'. */
  target_updates?: Partial<{
    title: string;
    title_he: string;
    description: string;
    due_date: string;
    due_time: string;
    priority: "urgent" | "high" | "medium" | "low";
    checklist: ChecklistItem[];
    tags: string[];
    source_link: string;
  }>;
  /** Subset of source_task_ids the user accepted the AI's "already done" hint
   *  for. These get status='completed' instead of 'archived'. */
  sources_completed?: string[];
  merge_kind: string;
  ai_proposal?: unknown;
}

interface ChecklistItem {
  id: string;
  title: string;
  done: boolean;
  created_at?: string;
  completed_at?: string | null;
  created_by?: "user" | "ai";
}

// ── helpers ────────────────────────────────────────────────────────────────

function validateChecklist(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) throw new Error("checklist must be an array");
  return value.map((item, i) => {
    if (!item || typeof item !== "object") throw new Error(`checklist[${i}] must be an object`);
    const it = item as Record<string, unknown>;
    if (typeof it.id !== "string" || !it.id) throw new Error(`checklist[${i}].id required`);
    if (typeof it.title !== "string") throw new Error(`checklist[${i}].title must be a string`);
    if (typeof it.done !== "boolean") throw new Error(`checklist[${i}].done must be a boolean`);
    if (it.created_by !== undefined && it.created_by !== "user" && it.created_by !== "ai") {
      throw new Error(`checklist[${i}].created_by must be 'user' or 'ai'`);
    }
    return it as unknown as ChecklistItem;
  });
}

// ── POST /tasks/merge/propose ──────────────────────────────────────────────

const SYSTEM_PROPOSE = `You are an assistant that merges multiple smrtTask items
(tasks or AI-generated suggestions) into a single coherent task.

The user has selected N items from their inbox and asked to unify them. Your job
is to read every item — including the underlying email/document content where
available — and propose:
  1. A single clear title (English + Hebrew). If a target item was specified,
     keep its title as the spine.
  2. A coherent description that synthesizes the content (NOT a concatenation
     with separators — write fresh prose).
  3. A checklist (suggested_checklist) that breaks the merged work into
     ATOMIC next-actions — the smaller and more concrete, the better.

     CRITICAL RULES for checklist granularity:
     - If the work mentions checking/comparing/visiting MULTIPLE entities
       (websites, vendors, products, candidates, suppliers, options, etc.),
       create ONE separate checklist item PER entity. Never collapse "check
       prices on N sites" into a single item — that defeats the purpose of
       a checklist. The user wants to tick off each site individually.
     - Same rule for multi-step processes: each step is its own item.
       Example: "research → quote → order → confirm shipping" = 4 items.
     - Read the description AND the source emails carefully — entities are
       usually listed there (often comma-separated or in bullet form).
     - Each item should be a discrete next-action a person could check off
       in under 30 minutes. If an item still feels broad, split it further.
     - Aim for 3-12 items typically; do not artificially cap at 6.
     - Use imperative voice ("בדוק את X", "הזמן Y", not "צריך לבדוק").

     Cite which source it came from via source_task_id (use the IDs the
     user gave you).
  4. A recommended priority (urgent/high/medium/low) with a short reason.
  5. A recommended due_date (ISO YYYY-MM-DD) with a short reason — typically
     the earliest among the sources, but use judgment.
  6. Merged keywords + key_contacts (deduplicated semantically).
  7. already_done_warnings: items where evidence in the source content
     suggests the work has ALREADY been completed (e.g. an email reply
     "שלחתי, מחכה לתשובתך" indicates the "לשלוח" task was already done).
     Include source_task_id, the evidence quote, and confidence 0..1.
  8. coherence_warning (optional): if one source doesn't really belong with
     the others, surface that as a free-text suggestion.

Return STRICT JSON, no markdown fences, with this shape:

{
  "merged_title": "...",
  "merged_title_he": "...",
  "merged_description": "...",
  "suggested_checklist": [
    { "title": "...", "source_task_id": "uuid-of-origin" }
  ],
  "recommended_priority": "urgent|high|medium|low",
  "priority_reason": "...",
  "recommended_due_date": "YYYY-MM-DD" | null,
  "due_date_reason": "...",
  "merged_keywords": ["..."],
  "merged_contacts": ["..."],
  "already_done_warnings": [
    { "source_task_id": "uuid", "evidence": "...", "confidence": 0.0 }
  ],
  "coherence_warning": "..." | null
}

Write Hebrew text in Hebrew (titles, descriptions, checklist items). Keep
checklist titles short (3-8 words each).

WORKED EXAMPLE — atomic checklist:
  Input description: "צריך לבדוק ולהשוות מחירים בין ארבעה אתרים: everythingbranded.com,
                      everythingpromo.com, qualitylogoproducts.com ו-brandedpromo.com"
  WRONG checklist (too broad):  ["בדוק מחירים בכל האתרים"]
  RIGHT checklist (atomic):     ["בדוק ב-everythingbranded.com",
                                 "בדוק ב-everythingpromo.com",
                                 "בדוק ב-qualitylogoproducts.com",
                                 "בדוק ב-brandedpromo.com",
                                 "השווה הצעות ובחר ספק",
                                 "בצע הזמנה"]
  Six items, each tickable independently.`;

router.post("/tasks/merge/propose", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ProposeBody;
  const sourceIds = Array.isArray(body.source_task_ids) ? body.source_task_ids : [];
  if (sourceIds.length < 1) {
    return res.status(400).json({ error: "source_task_ids required (>=1)" });
  }
  if (sourceIds.length > 10) {
    return res.status(400).json({ error: "max 10 sources per merge" });
  }

  // Pull source rows with their source_message bodies (so the AI sees the
  // underlying email/whatsapp content, not just the task title).
  const { data: sources, error: srcErr } = await db
    .from("tasks")
    .select(`
      id, title, title_he, description, status, priority, due_date,
      task_type, checklist, ai_generated_content, source_link,
      ai_confidence, manually_verified, created_at, project_id,
      source_messages(source_type, sender, sender_email, subject, body_text, received_at)
    `)
    .eq("organization_id", req.org!.id)
    .in("id", sourceIds);

  if (srcErr) return res.status(500).json({ error: srcErr.message });
  if (!sources || sources.length !== sourceIds.length) {
    return res.status(404).json({ error: "one or more source tasks not found in this org" });
  }

  let target: Record<string, unknown> | null = null;
  if (body.target_task_id) {
    const { data: t, error: tErr } = await db
      .from("tasks")
      .select(`
        id, title, title_he, description, status, priority, due_date,
        task_type, checklist, ai_generated_content, source_link
      `)
      .eq("organization_id", req.org!.id)
      .eq("id", body.target_task_id)
      .maybeSingle();
    if (tErr) return res.status(500).json({ error: tErr.message });
    if (!t) return res.status(404).json({ error: "target task not found in this org" });
    target = t;
  }

  // Build the user message. Each source gets a fenced block with ID + content.
  const sourceBlocks = sources.map((s, i) => {
    // Body of underlying email/whatsapp message, truncated to keep cost down.
    const sm = (s as { source_messages?: { body_text?: string | null; subject?: string | null; sender?: string | null; sender_email?: string | null; received_at?: string | null; source_type?: string | null } | null }).source_messages;
    const bodyText = (sm?.body_text ?? "").slice(0, 1500);
    return `=== Source #${i + 1} ===
task_id: ${s.id}
task_type: ${s.task_type}
status: ${s.status}
title (en): ${s.title ?? ""}
title (he): ${s.title_he ?? ""}
priority: ${s.priority ?? ""}
due_date: ${s.due_date ?? "(none)"}
ai_confidence: ${(s as { ai_confidence?: number }).ai_confidence ?? "(none)"}
description:
${s.description ?? "(none)"}
checklist: ${JSON.stringify(s.checklist ?? [])}
ai_generated_content: ${JSON.stringify(s.ai_generated_content ?? null).slice(0, 500)}
${sm ? `source_message (${sm.source_type}): from=${sm.sender ?? sm.sender_email ?? "?"} subject=${sm.subject ?? ""}
received_at=${sm.received_at ?? ""}
body:
${bodyText}` : "(no source_message — manual task)"}`;
  }).join("\n\n");

  const targetBlock = target
    ? `\n\n=== TARGET (user pre-selected as the spine) ===
task_id: ${target.id}
title (en): ${target.title}
title (he): ${target.title_he}
priority: ${target.priority}
due_date: ${target.due_date ?? "(none)"}
description:
${target.description ?? "(none)"}
checklist: ${JSON.stringify(target.checklist ?? [])}`
    : "";

  const userMessage = `Merge the following ${sources.length} smrtTask item(s) into one. Return JSON.${targetBlock}\n\n${sourceBlocks}`;

  try {
    const { content } = await simpleCall(
      "sonnet",
      SYSTEM_PROPOSE,
      userMessage,
      2048,
      { component: "smrttask.merge.propose", userId: req.user!.id },
    );

    const proposal = parseJsonResponse<Record<string, unknown>>(content);
    if (!proposal) {
      return res.status(502).json({ error: "AI returned unparseable JSON", raw: content });
    }
    res.json({ proposal });
  } catch (e) {
    const msg = (e as Error).message ?? "AI call failed";
    res.status(500).json({ error: msg });
  }
});

// ── POST /tasks/merge ──────────────────────────────────────────────────────

router.post("/tasks/merge", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as MergeBody;
  const sourceIds = Array.isArray(body.source_task_ids) ? body.source_task_ids : [];
  if (sourceIds.length < 1) {
    return res.status(400).json({ error: "source_task_ids required (>=1)" });
  }
  if (!body.target || (body.target.mode !== "existing" && body.target.mode !== "new")) {
    return res.status(400).json({ error: "target.mode must be 'existing' or 'new'" });
  }
  if (!MERGE_KINDS.has(body.merge_kind)) {
    return res.status(400).json({ error: "invalid merge_kind" });
  }

  // Build the payload + target_id for the RPC.
  let targetId: string | null = null;
  let targetPayload: Record<string, unknown> = {};

  if (body.target.mode === "existing") {
    targetId = body.target.task_id;
    if (!targetId) return res.status(400).json({ error: "target.task_id required" });
    // Validate any provided updates
    if (body.target_updates?.checklist !== undefined) {
      try { validateChecklist(body.target_updates.checklist); }
      catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    }
    targetPayload = { ...(body.target_updates ?? {}) };
  } else {
    // mode === "new"
    if (!body.target.title && !body.target.title_he) {
      return res.status(400).json({ error: "target.title or target.title_he required" });
    }
    if (body.target.checklist !== undefined) {
      try { validateChecklist(body.target.checklist); }
      catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    }
    const t = body.target;
    targetPayload = {
      title: t.title,
      title_he: t.title_he,
      description: t.description,
      due_date: t.due_date,
      due_time: t.due_time,
      priority: t.priority ?? "medium",
      checklist: t.checklist ?? [],
      tags: t.tags,
      source_link: t.source_link,
      project_id: t.project_id,
      task_type: "action",
      status: "inbox",
    };
  }

  const sourcesCompleted = Array.isArray(body.sources_completed) ? body.sources_completed : [];

  const { data, error } = await db.rpc("merge_tasks", {
    p_org_id:            req.org!.id,
    p_user_id:           req.user!.id,
    p_source_ids:        sourceIds,
    p_target_id:         targetId,
    p_target_payload:    targetPayload,
    p_sources_completed: sourcesCompleted,
    p_merge_kind:        body.merge_kind,
    p_ai_proposal:       body.ai_proposal ?? null,
  });

  if (error) {
    // Map our custom errcodes back to HTTP statuses.
    const code = (error as { code?: string }).code;
    if (code === "40001") return res.status(409).json({ error: error.message });
    if (code === "42501") return res.status(403).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }

  // Fetch the resulting task with the usual joins for the UI.
  const resolvedTargetId = (data as { target_id: string }).target_id;
  const { data: targetRow, error: fetchErr } = await db
    .from("tasks")
    .select("*, source_messages(source_type, source_url, serial_display), projects(id, name, name_he, color, parent_id)")
    .eq("organization_id", req.org!.id)
    .eq("id", resolvedTargetId)
    .maybeSingle();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  res.json({
    ...(data as Record<string, unknown>),
    task: targetRow,
  });
});

// ── POST /tasks/merge/undo ─────────────────────────────────────────────────

router.post("/tasks/merge/undo", async (req: Request, res: Response) => {
  const mergeId = req.body?.merge_id;
  if (!mergeId || typeof mergeId !== "string") {
    return res.status(400).json({ error: "merge_id required" });
  }

  const { data, error } = await db.rpc("undo_task_merge", {
    p_org_id:   req.org!.id,
    p_user_id:  req.user!.id,
    p_merge_id: mergeId,
  });

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "40001") return res.status(409).json({ error: error.message });
    if (code === "42501") return res.status(403).json({ error: error.message });
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

export default router;
