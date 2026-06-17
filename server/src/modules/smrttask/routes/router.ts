/**
 * Router — AI-classified intent dispatcher for free-text input.
 *
 * Two entry points produce a decision row:
 *   POST /router/decide                  user-supplied text (sidebar / future chat)
 *   (whatsapp-webhook.ts inserts directly when from_phone === own display number)
 *
 * The decision is `pending` until the user reviews + applies via
 *   POST /router/decisions/:id/apply     body may override payload fields
 *   POST /router/decisions/:id/dismiss
 *
 *   GET  /router/decisions/:id           preview + fresh state
 *   GET  /router/decisions               recent (status filter optional)
 *
 * No DB writes to tasks happen on /decide — only on /apply. This lets the
 * user inspect + edit fields before the decision actually takes effect.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { emitEvent } from "../../../lib/platform";
import { simpleCall, parseJsonResponse, MODELS } from "../../../anthropic";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrttask"));

// ── types ────────────────────────────────────────────────────────────────

type Intent =
  | "create_task"
  | "update_task"
  | "add_subtask"
  | "add_update"
  | "complete_task"
  | "dismiss_task"
  | "save_info"
  | "unknown";

interface DecisionPayload {
  // create_task / update_task fields
  title_he?: string;
  description?: string;
  due_date?: string | null;        // YYYY-MM-DD
  priority?: "urgent" | "high" | "medium" | "low";
  recurrence_rule?: string | null;
  checklist?: string[];
  // add_subtask
  subtasks?: string[];
  // add_update
  update_text?: string;
  // save_info
  body?: string;
  new_project_name?: string;
  new_subproject_name?: string;
  // common
  notes_for_user?: string;
  // project assignment (create_task / update_task / save_info) — id of a project or
  // sub-project the task belongs to, matched from the user's project list.
  project_id?: string | null;
}

interface ClassifierOutput {
  intent: Intent;
  target_task_serial?: string | null;
  target_task_id?: string | null;
  confidence?: number;
  reasoning?: string;
  payload?: DecisionPayload;
}

// ── helpers ──────────────────────────────────────────────────────────────

interface OpenTaskRow {
  id: string;
  serial_display: string | null;
  title: string | null;
  title_he: string | null;
  status: string;
  due_date: string | null;
  priority: string | null;
}

async function fetchOpenTasks(userId: string, orgId: string): Promise<OpenTaskRow[]> {
  // Keep draft-plan (not-yet-approved) tasks out of the assistant's context.
  // Ordinary tasks have a null plan_id, so the null branch keeps them.
  const { data: draftPlans } = await db.from("smrtplan_plans").select("id").eq("org_id", orgId).eq("status", "draft");
  const draftIds = (draftPlans ?? []).map((p) => (p as { id: string }).id);
  let q = db
    .from("tasks")
    .select("id, serial_display, title, title_he, status, due_date, priority")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .in("status", ["inbox", "in_progress", "snoozed"]);
  if (draftIds.length) q = q.or(`plan_id.is.null,plan_id.not.in.(${draftIds.join(",")})`);
  const { data } = await q.order("created_at", { ascending: false }).limit(80);
  return (data ?? []) as OpenTaskRow[];
}

interface ProjectRow {
  id: string;
  name: string;
  name_he: string | null;
  parent_id: string | null;
}

async function fetchProjects(orgId: string): Promise<ProjectRow[]> {
  const { data } = await db
    .from("projects")
    .select("id, name, name_he, parent_id")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  return (data ?? []) as ProjectRow[];
}

export async function fetchProjectsForUser(orgId: string): Promise<ProjectRow[]> {
  return fetchProjects(orgId);
}

function buildSystemPrompt(): string {
  return `You are the intent router for smrtTask, a Hebrew-first personal task manager.

You receive ONE free-text input from the user (Hebrew or English) and a list of their currently open tasks. Decide the user's intent and produce a structured JSON action.

Possible intents:
- "create_task"   — user is describing a new action they need to do.
- "update_task"   — user wants to modify fields on an existing task (title, due date, priority, description, status).
- "add_subtask"   — user wants to append items to an existing task's checklist.
- "add_update"    — user is adding a free-text note/progress update to an existing task.
- "complete_task" — user is saying an existing task is done.
- "dismiss_task"  — user wants to dismiss/cancel an existing task.
- "save_info"     — user is sharing a piece of information (a fact, price, contact detail, note, reference) they want to save — NOT an action to do. Examples: "המחיר של X הוא 50 שקל", "מספר הטלפון של ספק Y הוא...", "שם המוצר שאנחנו עובדים איתו הוא...".
- "unknown"       — input is ambiguous or off-topic.

Rules for picking a target task:
- The user MAY reference a task by serial (e.g. "T42"), by title (full or partial, in either language), or by recent context ("the doctor thing").
- If you find a confident match, set "target_task_serial" to the matching task's serial_display ("T42" etc.).
- If multiple tasks could match, prefer the most recent one with the closest title match. Set "confidence" between 0 and 1.
- If no plausible existing task matches and the input is action-shaped, default to "create_task".

Output JSON shape (return ONLY valid JSON, no markdown fences):
{
  "intent": "create_task" | "update_task" | "add_subtask" | "add_update" | "complete_task" | "dismiss_task" | "save_info" | "unknown",
  "target_task_serial": "T42" | null,
  "confidence": 0.0-1.0,
  "reasoning": "one short sentence in Hebrew explaining your choice",
  "payload": {
    "title_he": "Hebrew title (create_task / update_task / save_info short heading)",
    "body": "full content for save_info (may be same as title_he if brief)",
    "description": "optional details for tasks",
    "due_date": "YYYY-MM-DD or null",
    "priority": "urgent|high|medium|low",
    "recurrence_rule": "RRULE string or null",
    "checklist": ["item 1", "item 2"],
    "subtasks": ["new subtask 1"],
    "update_text": "free-text progress note",
    "notes_for_user": "optional clarifying note shown in the preview",
    "project_id": "uuid of the matched existing project/sub-project, or null",
    "new_project_name": "name of a NEW top-level project to create (save_info only), or null",
    "new_subproject_name": "name of a NEW sub-project to create (save_info only), or null"
  }
}

Only include payload fields that are relevant to the chosen intent:
- create_task: title_he (required), description, due_date, priority, recurrence_rule, checklist, project_id
- update_task: any of title_he/description/due_date/priority/project_id — only the fields the user explicitly changed
- add_subtask: subtasks (array of strings)
- add_update: update_text
- complete_task / dismiss_task: leave payload empty unless the user provided a reason in description
- save_info: title_he (required, short heading ≤80 chars), body (full text, may equal title_he if brief), project_id (matched from list or null), and new_project_name / new_subproject_name when the user asks to file the info under a project/sub-project that does NOT yet exist (see "Creating new projects" below)
- unknown: leave payload empty, set notes_for_user to a clarifying question in Hebrew

Date interpretation: relative dates ("מחר", "ביום ראשון", "in 3 days") should be resolved against the given "today" date.
Priority defaults to "medium" unless the user signals urgency.
Checklist: only populate when the user describes multiple discrete sub-items.

Project assignment:
- A "Projects" list is provided with each project's id, name, and whether it is a sub-project of another. If the input names or clearly refers to one of them, set payload.project_id to that project's exact id from the list.
- A sub-project is a more specific match than its parent — when the user names the sub-project (or both), choose the SUB-PROJECT's id.
- Only ever use an id that appears verbatim in the provided list. If no project is referenced, or you are unsure, set project_id to null. Never invent an id.

Creating new projects (save_info only):
- If the user explicitly asks to file the info under a project or sub-project that is NOT in the list — phrases like "תת פרוייקט חדש", "פרויקט חדש", "create a new project / sub-project", "תפתח תת-פרויקט" — do NOT force-match an existing project. Create the new one instead.
- New SUB-project under an EXISTING parent: set project_id to the existing parent's exact id from the list, AND new_subproject_name to the new sub-project's name. (Example: input names parent "אישי" and "תת פרוייקט חדש - סיוע בדירה/אוכל" → project_id = id of "אישי", new_subproject_name = "סיוע בדירה/אוכל".)
- New TOP-LEVEL project: set new_project_name. To also create a sub under that brand-new parent, additionally set new_subproject_name.
- If a project/sub-project with that name already EXISTS in the list, prefer matching its id via project_id over re-creating it.

DEEP-LINK PRESERVATION (system-wide): if the user's text contains a
specific URL, you MUST emit it verbatim in description / body / checklist
items / subtasks — never strip it down to the bare domain. The point of
this system is to take the user from inbox to the right page in one
click. Bare-domain links defeat that.`;
}

function buildProjectList(projects: ProjectRow[]): string {
  if (projects.length === 0) return "(no projects)";
  const nameOf = (p: ProjectRow) => p.name_he || p.name || "(no name)";
  const byId = new Map(projects.map((p) => [p.id, p]));
  const roots = projects.filter((p) => !p.parent_id || !byId.has(p.parent_id));
  const childrenOf = (id: string) => projects.filter((p) => p.parent_id === id);

  const lines: string[] = [];
  for (const root of roots) {
    lines.push(`- ${nameOf(root)} [id=${root.id}]`);
    for (const child of childrenOf(root.id)) {
      lines.push(`  - ${nameOf(child)} [id=${child.id}] (sub-project of ${nameOf(root)})`);
    }
  }
  return lines.join("\n");
}

function buildUserMessage(
  input: string,
  openTasks: OpenTaskRow[],
  projects: ProjectRow[],
  today: string,
): string {
  const taskList = openTasks.length === 0
    ? "(no open tasks)"
    : openTasks.map((t) => {
        const title = t.title_he || t.title || "(no title)";
        const due = t.due_date ? ` due=${t.due_date}` : "";
        const status = ` [${t.status}]`;
        return `- ${t.serial_display ?? "?"}: ${title}${due}${status}`;
      }).join("\n");

  return `Today: ${today}

Open tasks:
${taskList}

Projects:
${buildProjectList(projects)}

User input:
"""
${input}
"""

Respond with the JSON action only.`;
}

export async function fetchOpenTasksForUser(userId: string, orgId: string): Promise<OpenTaskRow[]> {
  return fetchOpenTasks(userId, orgId);
}

export async function classifyRouterInput(input: string, openTasks: OpenTaskRow[], projects: ProjectRow[] = []):
  Promise<{ output: ClassifierOutput; modelUsed: string; costUsd: number; raw: string }> {
  return classify(input, openTasks, projects);
}

async function classify(input: string, openTasks: OpenTaskRow[], projects: ProjectRow[] = []):
  Promise<{ output: ClassifierOutput; modelUsed: string; costUsd: number; raw: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(input, openTasks, projects, today);

  const { content, costUsd } = await simpleCall("sonnet", systemPrompt, userMessage, 900);
  const parsed = parseJsonResponse<ClassifierOutput>(content);

  if (!parsed || !parsed.intent) {
    return {
      output: {
        intent: "unknown",
        reasoning: "Could not parse AI output as JSON",
        payload: { notes_for_user: "מודל ה-AI לא החזיר תוצאה תקינה — צרי משימה ידנית או נסי שוב." },
      },
      modelUsed: MODELS.sonnet,
      costUsd,
      raw: content,
    };
  }
  return { output: parsed, modelUsed: MODELS.sonnet, costUsd, raw: content };
}

/** Resolve a referenced task by serial. Returns the row or null. */
async function resolveTargetTask(
  userId: string,
  orgId: string,
  serial: string | null | undefined,
): Promise<OpenTaskRow | null> {
  if (!serial) return null;
  const { data } = await db
    .from("tasks")
    .select("id, serial_display, title, title_he, status, due_date, priority")
    .eq("user_id", userId)
    .eq("organization_id", orgId)
    .eq("serial_display", serial)
    .maybeSingle();
  return (data ?? null) as OpenTaskRow | null;
}

/** Confirm a project id belongs to this org. Returns the id or null. */
async function validateProjectId(
  projectId: string | null | undefined,
  orgId: string,
): Promise<string | null> {
  if (!projectId) return null;
  const { data } = await db
    .from("projects")
    .select("id")
    .eq("organization_id", orgId)
    .eq("id", projectId)
    .maybeSingle();
  return data ? projectId : null;
}

// ── POST /router/decide ─────────────────────────────────────────────────

router.post("/router/decide", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.org!.id;
  const inputText = String(req.body?.input ?? "").trim();
  const source = (req.body?.source as string) === "whatsapp_self" ? "whatsapp_self" : "sidebar";
  const sourceMessageId = (req.body?.source_message_id as string | undefined) || null;

  if (!inputText) return res.status(400).json({ error: "input required" });
  if (inputText.length > 4000) return res.status(400).json({ error: "input too long" });

  const [openTasks, projects] = await Promise.all([
    fetchOpenTasks(userId, orgId),
    fetchProjects(orgId),
  ]);
  const { output, modelUsed, costUsd } = await classify(inputText, openTasks, projects);

  const targetTask = await resolveTargetTask(userId, orgId, output.target_task_serial ?? null);

  const { data, error } = await db
    .from("router_decisions")
    .insert({
      user_id: userId,
      organization_id: orgId,
      source,
      source_message_id: sourceMessageId,
      input_text: inputText,
      intent: output.intent,
      target_task_id: targetTask?.id ?? null,
      payload: output.payload ?? {},
      reasoning: output.reasoning ?? null,
      model_used: modelUsed,
      cost_usd: costUsd,
      status: "pending",
    })
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({
    decision: data,
    target_task: targetTask,
    open_tasks_count: openTasks.length,
  });
});

// ── GET /router/decisions/:id ───────────────────────────────────────────

router.get("/router/decisions/:id", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { data, error } = await db
    .from("router_decisions")
    .select("*")
    .eq("user_id", userId)
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "not found" });

  let targetTask: OpenTaskRow | null = null;
  if (data.target_task_id) {
    const { data: t } = await db
      .from("tasks")
      .select("id, serial_display, title, title_he, status, due_date, priority")
      .eq("user_id", userId)
      .eq("id", data.target_task_id)
      .maybeSingle();
    targetTask = (t ?? null) as OpenTaskRow | null;
  }
  res.json({ decision: data, target_task: targetTask });
});

// ── POST /router/decisions/:id/dismiss ──────────────────────────────────

router.post("/router/decisions/:id/dismiss", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { error } = await db
    .from("router_decisions")
    .update({ status: "dismissed" })
    .eq("user_id", userId)
    .eq("id", req.params.id)
    .eq("status", "pending");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /router/decisions/:id/apply ────────────────────────────────────

router.post("/router/decisions/:id/apply", async (req: Request, res: Response) => {
  const userId = req.user!.id;

  const { data: decision, error: dErr } = await db
    .from("router_decisions")
    .select("*")
    .eq("user_id", userId)
    .eq("id", req.params.id)
    .maybeSingle();

  if (dErr)     return res.status(500).json({ error: dErr.message });
  if (!decision) return res.status(404).json({ error: "decision not found" });
  if (decision.status !== "pending") {
    return res.status(409).json({ error: `decision is ${decision.status}` });
  }

  // Prefer the org captured when the decision was queued (sidebar always
  // sets it; whatsapp_self resolves to primary org). Fall back to the
  // caller's active org if the decision predates the column.
  const orgId = (decision.organization_id as string | null) ?? req.org!.id;

  // Caller can override payload + intent + target_task_id (the user may have
  // edited the preview before confirming, or picked a different target).
  const overrides = (req.body ?? {}) as {
    intent?: Intent;
    target_task_id?: string | null;
    payload?: DecisionPayload;
  };

  const intent: Intent = overrides.intent ?? (decision.intent as Intent);
  const targetTaskId = overrides.target_task_id ?? decision.target_task_id;
  const payload: DecisionPayload = { ...(decision.payload as DecisionPayload), ...(overrides.payload ?? {}) };

  let appliedTaskId: string | null = null;
  // save_info produces a project_information_items row, not a task. It is
  // tracked separately because applied_task_id has an FK to tasks(id) and
  // must never hold an info-item id (router_decisions_applied_task_id_fkey).
  let appliedInfoItemId: string | null = null;

  try {
    if (intent === "create_task") {
      const title = (payload.title_he || decision.input_text).trim().slice(0, 200);
      const now = new Date().toISOString();
      const checklist = Array.isArray(payload.checklist)
        ? payload.checklist
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((t) => ({
            id: randomUUID(),
            title: t,
            done: false,
            created_at: now,
            completed_at: null,
            created_by: "ai" as const,
          }))
        : [];

      const insertBody: Record<string, unknown> = {
        user_id: userId,
        organization_id: orgId,
        task_type: "action",
        title,
        title_he: title,
        description: payload.description ?? "",
        priority: payload.priority ?? "medium",
        status: "inbox",
        manually_verified: true,
        due_date: payload.due_date ?? null,
        recurrence_rule: payload.recurrence_rule ?? null,
      };
      if (checklist.length > 0) insertBody.checklist = checklist;
      const projectId = await validateProjectId(payload.project_id, orgId);
      if (projectId) insertBody.project_id = projectId;

      const { data: task, error } = await db
        .from("tasks")
        .insert(insertBody)
        .select("*, source_messages(id, source_type, source_id, source_url, serial_display), projects(id, name, name_he, color, parent_id)")
        .single();
      if (error) throw new Error(error.message);
      appliedTaskId = task.id as string;

      await emitEvent(orgId, "smrttask", "task.created", "task", task.id, {
        title: task.title,
        priority: task.priority,
        via: "router",
      });
    } else if (intent === "update_task") {
      if (!targetTaskId) throw new Error("target_task_id required for update_task");
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (payload.title_he) {
        // Mirror the Hebrew title into both columns so the editor and the
        // i18n-aware UI never show a stale English title for a task whose
        // canonical name was just rewritten. This matches the create_task
        // branch above and the existing TaskDetail save path.
        updates.title_he = payload.title_he;
        updates.title    = payload.title_he;
      }
      if (payload.description != null)    updates.description = payload.description;
      if (payload.due_date !== undefined)  updates.due_date = payload.due_date;
      if (payload.priority)               updates.priority = payload.priority;
      // Only set a project when one is named — never let a null from the
      // classifier (which doesn't know the task's current project) silently
      // clear an existing assignment on an unrelated field edit.
      if (payload.project_id) {
        const pid = await validateProjectId(payload.project_id, orgId);
        if (pid) updates.project_id = pid;
      }

      const { error } = await db
        .from("tasks")
        .update(updates)
        .eq("organization_id", orgId)
        .eq("id", targetTaskId);
      if (error) throw new Error(error.message);
      appliedTaskId = targetTaskId;
    } else if (intent === "add_subtask") {
      if (!targetTaskId) throw new Error("target_task_id required for add_subtask");
      const items = Array.isArray(payload.subtasks)
        ? payload.subtasks.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : [];
      if (items.length === 0) throw new Error("no subtasks to add");

      const { data: t } = await db
        .from("tasks")
        .select("checklist")
        .eq("organization_id", orgId)
        .eq("id", targetTaskId)
        .maybeSingle();
      const existing = Array.isArray((t as { checklist?: unknown })?.checklist) ? (t as { checklist: unknown[] }).checklist : [];
      const now = new Date().toISOString();
      const appended = [
        ...existing,
        ...items.map((title) => ({
          id: randomUUID(),
          title,
          done: false,
          created_at: now,
          completed_at: null,
          created_by: "user" as const,
        })),
      ];
      const { error } = await db
        .from("tasks")
        .update({ checklist: appended, updated_at: now })
        .eq("organization_id", orgId)
        .eq("id", targetTaskId);
      if (error) throw new Error(error.message);
      appliedTaskId = targetTaskId;
    } else if (intent === "add_update") {
      if (!targetTaskId) throw new Error("target_task_id required for add_update");
      const text = (payload.update_text || decision.input_text).trim();
      if (!text) throw new Error("update text empty");

      // Append to tasks.updates[] via read-modify-write
      const { data: t } = await db
        .from("tasks")
        .select("updates")
        .eq("organization_id", orgId)
        .eq("id", targetTaskId)
        .maybeSingle();
      const existing = Array.isArray((t as { updates?: unknown })?.updates) ? (t as { updates: unknown[] }).updates : [];
      const entry = {
        id: randomUUID(),
        content: text,
        type: "manual",
        created_at: new Date().toISOString(),
        actor: "user",
      };
      const { error } = await db
        .from("tasks")
        .update({ updates: [...existing, entry], updated_at: new Date().toISOString() })
        .eq("organization_id", orgId)
        .eq("id", targetTaskId);
      if (error) throw new Error(error.message);
      appliedTaskId = targetTaskId;
    } else if (intent === "complete_task") {
      if (!targetTaskId) throw new Error("target_task_id required for complete_task");
      const now = new Date().toISOString();
      const { error } = await db
        .from("tasks")
        .update({ status: "completed", status_changed_at: now, completed_at: now, updated_at: now })
        .eq("organization_id", orgId)
        .eq("id", targetTaskId);
      if (error) throw new Error(error.message);
      appliedTaskId = targetTaskId;
    } else if (intent === "dismiss_task") {
      if (!targetTaskId) throw new Error("target_task_id required for dismiss_task");
      const now = new Date().toISOString();
      const { error } = await db
        .from("tasks")
        .update({ status: "archived", status_changed_at: now, updated_at: now })
        .eq("organization_id", orgId)
        .eq("id", targetTaskId);
      if (error) throw new Error(error.message);
      appliedTaskId = targetTaskId;
    } else if (intent === "save_info") {
      // Idempotency: a previous apply may have inserted the info item (and any
      // on-the-fly project) but failed before flipping the decision to
      // 'applied' — leaving status='pending'. Reuse the existing item instead
      // of creating duplicate items/projects on retry.
      const { data: existingRows, error: existErr } = await db
        .from("project_information_items")
        .select("id")
        .eq("source_router_decision_id", decision.id)
        .limit(1);
      if (existErr) throw new Error(existErr.message);
      if (existingRows && existingRows.length > 0) {
        appliedInfoItemId = (existingRows[0] as { id: string }).id;
      } else {
      const title = (payload.title_he || decision.input_text).trim().slice(0, 200);
      const body = (payload.body || payload.title_he || decision.input_text).trim();
      if (!title) throw new Error("title required for save_info");

      let projectId: string | null = null;

      // Find-or-create a project by name under an optional parent. Dedups on
      // (organization_id, parent_id, name) so naming an existing project/
      // sub-project never spawns a duplicate. user_id is set for RLS isolation.
      const findOrCreateProject = async (parentId: string | null, rawName: string): Promise<string> => {
        const name = rawName.trim();
        let findQ = db
          .from("projects")
          .select("id")
          .eq("organization_id", orgId)
          .eq("name", name)
          .eq("is_active", true)
          .limit(1);
        findQ = parentId ? findQ.eq("parent_id", parentId) : findQ.is("parent_id", null);
        const { data: existing, error: findErr } = await findQ;
        if (findErr) throw new Error(findErr.message);
        if (existing && existing.length > 0) return (existing[0] as { id: string }).id;
        const { data: created, error: createErr } = await db
          .from("projects")
          .insert({ user_id: userId, organization_id: orgId, name, name_he: name, parent_id: parentId, is_active: true })
          .select("id")
          .single();
        if (createErr) throw new Error(createErr.message);
        return (created as { id: string }).id;
      };

      // Resolve the project this info belongs to:
      //  (a) new_project_name      → a brand-new top-level project
      //      (+ new_subproject_name → and a sub-project under it).
      //  (b) existing project_id + new_subproject_name
      //                            → a NEW sub-project under that existing parent.
      //  (c) existing project_id, no new sub → use it as-is (may be null).
      if (payload.new_project_name?.trim().length) {
        const parentId = await findOrCreateProject(null, payload.new_project_name);
        projectId = payload.new_subproject_name?.trim()
          ? await findOrCreateProject(parentId, payload.new_subproject_name)
          : parentId;
      } else {
        const parentId = await validateProjectId(payload.project_id, orgId);
        projectId = payload.new_subproject_name?.trim()
          ? await findOrCreateProject(parentId, payload.new_subproject_name)
          : parentId;
      }

      const { data: infoItem, error } = await db
        .from("project_information_items")
        .insert({
          user_id: userId,
          organization_id: orgId,
          project_id: projectId,
          title,
          body,
          source: "router",
          source_router_decision_id: decision.id,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      appliedInfoItemId = (infoItem as { id: string }).id;
      }
    } else {
      return res.status(400).json({ error: `cannot apply intent ${intent}` });
    }

    const { error: updErr } = await db
      .from("router_decisions")
      .update({
        status: "applied",
        applied_task_id: appliedTaskId,
        applied_at: new Date().toISOString(),
        intent,
        target_task_id: targetTaskId,
        payload,
      })
      .eq("id", decision.id);
    if (updErr) throw new Error(updErr.message);

    res.json({ ok: true, applied_task_id: appliedTaskId, info_item_id: appliedInfoItemId, intent });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default router;
