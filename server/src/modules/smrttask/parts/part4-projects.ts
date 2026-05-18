/**
 * PART 4 — Project Suggester + Brief Builder
 *
 * Two jobs in one part, selected via `mode`:
 *
 * MODE "suggest":
 *   Looks at all approved tasks from the last 60 days.
 *   Asks Claude to identify clusters that look like ongoing projects.
 *   Creates a task with task_type="project_suggestion" for each cluster.
 *   Runs once after ~1 week of data, or on-demand from Admin Sync page.
 *
 * MODE "build_brief":
 *   Given a project_id, pulls all linked tasks + source messages.
 *   Asks Claude to extract structured facts (contacts, topics, timeline, links).
 *   Saves facts as pending_facts on project_briefs for user verification.
 */

import { db, createRunSession, closeRunSession } from "../../../db";
import { cachedCall, simpleCall, parseJsonResponse, MODELS } from "../../../anthropic";
import { getUserPromptContext, formatIdentity } from "../../../lib/user-context";
import { loadPrompt } from "../../../lib/prompt-loader";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProjectCluster {
  name_he: string;
  description_he: string;
  task_ids: string[];
  keywords: string[];
  key_contacts: string[];
  confidence: number;
}

interface ProjectFact {
  id: string;
  type: "contact" | "keyword" | "timeline" | "link" | "topic" | "note";
  value: string;
  source_task_id?: string;
  extracted_at: string;
}

export interface Part4Options {
  userId: string;
  /** Active organization — scopes all task/project queries and stamps new rows. Required. */
  orgId: string;
  mode: "suggest" | "build_brief";
  /** Required when mode = "build_brief" */
  projectId?: string;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runPart4(opts: Part4Options): Promise<{ sessionId: string }> {
  const { userId, orgId, mode } = opts;
  if (!orgId) throw new Error("Part4: orgId is required");
  const sessionId = await createRunSession(userId, "part4", mode === "suggest" ? "classifier" : "collector");

  try {
    if (mode === "suggest") {
      await suggestProjects(userId, orgId, sessionId);
    } else if (mode === "build_brief" && opts.projectId) {
      await buildBrief(userId, orgId, opts.projectId, sessionId);
    } else {
      throw new Error("build_brief mode requires projectId");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await closeRunSession(sessionId, "failed", { errors_count: 1 }, `Fatal: ${msg}`, [msg]);
    throw err;
  }

  return { sessionId };
}

// ── Mode: suggest projects ─────────────────────────────────────────────────

async function suggestProjects(userId: string, orgId: string, sessionId: string) {
  const identity = formatIdentity(await getUserPromptContext(userId, orgId));
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch approved tasks in this org from the last 60 days
  const { data: tasks } = await db
    .from("tasks")
    .select("id, title_he, title, related_contact, related_contact_email, tags, description, created_at")
    .eq("organization_id", orgId)
    .eq("manually_verified", true)
    .neq("status", "archived")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  if (!tasks || tasks.length < 3) {
    await closeRunSession(sessionId, "completed", {}, "Not enough tasks to suggest projects (need ≥ 3).");
    return;
  }

  // Get existing project names in this org to avoid re-suggesting
  const { data: existingProjects } = await db
    .from("projects")
    .select("name, name_he")
    .eq("organization_id", orgId);
  const existingNames = (existingProjects ?? [])
    .map((p) => p.name_he ?? p.name)
    .join(", ");

  const taskList = tasks
    .map((t) =>
      `[id:${t.id}] ${t.title_he ?? t.title} | contact: ${t.related_contact ?? ""} ${t.related_contact_email ?? ""} | tags: ${(t.tags as string[] | null)?.join(",") ?? ""}`
    )
    .join("\n");

  const defaultSuggestSystem = `You identify ongoing projects from a list of tasks for {{user}}.

A "project" is a group of 3+ tasks that share a topic, contact, or goal and represent ongoing work — not one-off tasks.

Existing projects (do NOT re-suggest these): {{existingProjects}}

Return ONLY valid JSON array. Each entry:
{
  "name_he": "Hebrew project name (short, clear)",
  "description_he": "1-2 sentence Hebrew description of the project",
  "task_ids": ["id1","id2","id3"],
  "keywords": ["keyword1","keyword2"],
  "key_contacts": ["contact name or email"],
  "confidence": 0.0-1.0
}

Return [] if no clear projects emerge. Do NOT invent projects. Only group what's clearly related.`;

  const suggestSystem = ((await loadPrompt(userId, "project_suggester")) ?? defaultSuggestSystem)
    .replace("{{user}}", identity)
    .replace("{{existingProjects}}", existingNames || "none");

  const { content } = await simpleCall("sonnet", suggestSystem, `TASKS:\n${taskList}`, 2048);

  const clusters = parseJsonResponse<ProjectCluster[]>(content) ?? [];

  let tasksCreated = 0;
  for (const cluster of clusters) {
    if (cluster.confidence < 0.65 || cluster.task_ids.length < 3) continue;

    // Avoid duplicate suggestions in this org
    const { data: existing } = await db
      .from("tasks")
      .select("id")
      .eq("organization_id", orgId)
      .eq("task_type", "project_suggestion")
      .ilike("title_he", cluster.name_he)
      .maybeSingle();

    if (existing) continue;

    await db.from("tasks").insert({
      user_id: userId,
      organization_id: orgId,
      title: cluster.name_he,
      title_he: cluster.name_he,
      description: cluster.description_he,
      priority: "medium",
      status: "inbox",
      task_type: "project_suggestion",
      manually_verified: false,
      ai_confidence: cluster.confidence,
      ai_model_used: MODELS.sonnet,
      // Store clustered task IDs + keywords in ai_generated_content for approval step
      ai_generated_content: [{
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        action_label: "project_cluster",
        clustered_task_ids: cluster.task_ids,
        keywords: cluster.keywords,
        key_contacts: cluster.key_contacts,
      }],
    });
    tasksCreated++;
  }

  await closeRunSession(
    sessionId,
    "completed",
    { tasks_created: tasksCreated, items_processed: tasks.length },
    `Analyzed ${tasks.length} tasks. Suggested ${tasksCreated} projects.`,
  );
}

// ── Mode: build brief ──────────────────────────────────────────────────────

async function buildBrief(userId: string, orgId: string, projectId: string, sessionId: string) {
  const identity = formatIdentity(await getUserPromptContext(userId, orgId));
  // Load project — must belong to active org
  const { data: project } = await db
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .eq("organization_id", orgId)
    .single();

  if (!project) throw new Error(`Project ${projectId} not found in active org`);

  // Load linked tasks in this org
  const { data: tasks } = await db
    .from("tasks")
    .select("id, title_he, title, description, related_contact, related_contact_email, related_contact_phone, tags, source_message_id, due_date, source_link")
    .eq("project_id", projectId)
    .eq("organization_id", orgId)
    .neq("status", "archived")
    .order("created_at", { ascending: false })
    .limit(50);

  if (!tasks || tasks.length === 0) {
    await closeRunSession(sessionId, "completed", {}, "No tasks linked to project yet.");
    return;
  }

  // Load source messages for those tasks
  const sourceIds = tasks
    .map((t) => t.source_message_id as string | null)
    .filter(Boolean) as string[];

  const { data: sources } = sourceIds.length
    ? await db
        .from("source_messages")
        .select("source_id, sender, sender_email, subject, body_text, source_type, received_at")
        .eq("user_id", userId)
        .in("source_id", sourceIds)
        .limit(30)
    : { data: [] };

  const taskBlock = tasks
    .map((t) =>
      `[${t.title_he ?? t.title}] contact: ${t.related_contact ?? ""} ${t.related_contact_email ?? ""} ${t.related_contact_phone ?? ""} | due: ${t.due_date ?? ""} | tags: ${(t.tags as string[] | null)?.join(",") ?? ""}`
    )
    .join("\n");

  const sourceBlock = (sources ?? [])
    .map((s) => `[${s.source_type}] From: ${s.sender ?? s.sender_email} | ${s.subject ?? ""}: ${(s.body_text ?? "").slice(0, 200)}`)
    .join("\n");

  const projectName = (project.name_he as string | null) ?? (project.name as string);

  const defaultBriefSystem = `You extract structured facts about a project from tasks and messages, for {{user}}.

Extract as many useful facts as possible. Each fact is ONE piece of information.
Return ONLY valid JSON array:
[
  { "type": "contact",  "value": "Name — email — phone (if known)" },
  { "type": "keyword",  "value": "term that appears in messages about this project" },
  { "type": "timeline", "value": "date or deadline (e.g. annual event April–June)" },
  { "type": "topic",    "value": "recurring theme or subtopic" },
  { "type": "link",     "value": "URL or document name if mentioned" },
  { "type": "note",     "value": "any other useful context" }
]

Be specific. Use Hebrew where appropriate. Do not repeat facts.`;

  const briefSystem = ((await loadPrompt(userId, "brief_builder")) ?? defaultBriefSystem)
    .replace("{{user}}", identity);

  const { content } = await simpleCall(
    "sonnet",
    briefSystem,
    `PROJECT: ${projectName}\n\nTASKS:\n${taskBlock}\n\nSOURCE MESSAGES:\n${sourceBlock}`,
    2048,
  );

  const extractedFacts = parseJsonResponse<Omit<ProjectFact, "id" | "extracted_at">[]>(content) ?? [];

  const pendingFacts: ProjectFact[] = extractedFacts.map((f) => ({
    ...f,
    id: crypto.randomUUID(),
    extracted_at: new Date().toISOString(),
  }));

  // Load or create project_briefs row
  const { data: existingBrief } = await db
    .from("project_briefs")
    .select("id, pending_facts")
    .eq("project_id", projectId)
    .maybeSingle();

  if (existingBrief) {
    const existing = (existingBrief.pending_facts as ProjectFact[] | null) ?? [];
    // Avoid duplicate facts
    const existingValues = new Set(existing.map((f) => f.value));
    const newFacts = pendingFacts.filter((f) => !existingValues.has(f.value));
    await db
      .from("project_briefs")
      .update({ pending_facts: [...existing, ...newFacts] })
      .eq("id", existingBrief.id);
  } else {
    await db.from("project_briefs").insert({
      project_id: projectId,
      user_id: userId,
      pending_facts: pendingFacts,
      verified_facts: [],
      rejected_facts: [],
    });
  }

  await closeRunSession(
    sessionId,
    "completed",
    { items_processed: tasks.length },
    `Extracted ${pendingFacts.length} facts for "${projectName}".`,
  );
}
