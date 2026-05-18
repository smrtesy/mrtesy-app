/**
 * PART 3 — Deep Classifier
 *
 * For each pending source_message:
 *   1. Checks if it's a follow-up to an OPEN task → appends update, no new task
 *   2. Classifies as ACTIONABLE or INFORMATIONAL
 *   3. For ACTIONABLE: matches to an active project (if any), creates/updates task
 *
 * Processes in batches of 5 to keep the Claude prompt cache warm.
 */

import { db, loadRules, createRunSession, closeRunSession } from "../../../db";
import { cachedCall, parseJsonResponse, MODELS } from "../../../anthropic";
import { DEEP_CLASSIFIER_SYSTEM } from "../../../prompts/classifier";

const BATCH_SIZE = 5;

interface ClassificationResult {
  action: "new_task" | "update_task";

  // update_task fields
  task_id?: string;
  update_he?: string;

  // new_task fields
  classification?: "ACTIONABLE" | "INFORMATIONAL";
  confidence: number;
  reason_he?: string;
  project_id?: string | null;
  project_confidence?: number;
  suggested_rule?: {
    trigger: string;
    rule_type: string;
    reason: string;
  } | null;
  task?: {
    title_he: string;
    priority: string;
    due_date: string | null;
    description_he: string;
    contact_person?: string;
    category: string;
    tags: string[];
    suggested_actions: string[];
  };
}

export interface Part3Options {
  userId: string;
  /** Active organization — new tasks belong to this org. Required. */
  orgId: string;
  /** Max items to process in one run. Default: 50 */
  limit?: number;
}

export async function runPart3(opts: Part3Options): Promise<{ sessionId: string }> {
  const { userId, orgId, limit = 50 } = opts;
  if (!orgId) throw new Error("Part3: orgId is required");
  const sessionId = await createRunSession(userId, "part3", "classifier", MODELS.sonnet);

  const errors: string[] = [];
  let tasksCreated = 0;
  let tasksUpdated = 0;
  let actionableCount = 0;
  let informationalCount = 0;
  let rulesAdded = 0;
  let itemsProcessed = 0;

  try {
    // ── 1. Load rules (cached in rulesContext) ────────────────────────────────
    const rules = await loadRules(userId);
    const skipRules = rules
      .filter((r) => r.rule_type === "skip" || r.rule_type === "skip_spam")
      .map((r) => `- ${r.trigger}: ${r.reason ?? r.action ?? "skip"}`)
      .join("\n");
    const writingStyleHe = rules.find((r) => r.trigger === "writing_style_he")?.action ?? "";
    const writingStyleEn = rules.find((r) => r.trigger === "writing_style_en")?.action ?? "";

    // ── 2. Load open tasks for update-threading (scoped to active org) ───────
    const { data: openTasks } = await db
      .from("tasks")
      .select("id, title_he, title, related_contact, related_contact_email, related_contact_phone, tags, source_message_id")
      .eq("organization_id", orgId)
      .in("status", ["inbox", "in_progress"])
      .eq("manually_verified", true)
      .order("created_at", { ascending: false })
      .limit(30);

    const openTasksBlock = (openTasks ?? []).length > 0
      ? "OPEN TASKS (check for follow-ups before creating new):\n" +
        (openTasks ?? []).map((t) =>
          `[id:${t.id}] ${t.title_he ?? t.title} | contact: ${t.related_contact ?? ""} ${t.related_contact_email ?? ""} ${t.related_contact_phone ?? ""} | tags: ${(t.tags as string[] | null)?.join(",") ?? ""}`
        ).join("\n")
      : "";

    // ── 3. Load active projects for matching (scoped to active org) ──────────
    const { data: activeProjects } = await db
      .from("projects")
      .select("id, name, name_he, keywords, key_contacts")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .limit(20);

    const projectsBlock = (activeProjects ?? []).length > 0
      ? "\nACTIVE PROJECTS (match tasks to projects):\n" +
        (activeProjects ?? []).map((p) => {
          const keywords = (p.keywords as string[] | null)?.join(", ") ?? "";
          const contacts = (p.key_contacts as string[] | null)?.join(", ") ?? "";
          return `[id:${p.id}] ${p.name_he ?? p.name} | keywords: ${keywords} | contacts: ${contacts}`;
        }).join("\n")
      : "";

    // ── 4. Build rulesContext (cached block) ──────────────────────────────────
    const rulesContext = [
      skipRules ? `SKIP RULES:\n${skipRules}` : "",
      writingStyleHe ? `WRITING STYLE (Hebrew):\n${writingStyleHe}` : "",
      writingStyleEn ? `WRITING STYLE (English):\n${writingStyleEn}` : "",
      openTasksBlock,
      projectsBlock,
    ]
      .filter(Boolean)
      .join("\n\n");

    // ── 5. Fetch pending messages (FIFO) ──────────────────────────────────────
    const { data: pending, error: fetchError } = await db
      .from("source_messages")
      .select("*")
      .eq("user_id", userId)
      .eq("processing_status", "pending")
      .order("received_at", { ascending: true })
      .limit(limit);

    if (fetchError) throw new Error(`fetch pending: ${fetchError.message}`);
    if (!pending || pending.length === 0) {
      await closeRunSession(sessionId, "completed", {}, "No pending items.");
      return { sessionId };
    }

    // ── 6. Process in batches of BATCH_SIZE ───────────────────────────────────
    for (let i = 0; i < pending.length; i++) {
      const msg = pending[i];
      itemsProcessed++;

      await db
        .from("source_messages")
        .update({ processing_status: "processing" })
        .eq("id", msg.id);

      // Check for existing task with same source_id (dedup — scoped to active org)
      const { data: existingTask } = await db
        .from("tasks")
        .select("id, status, updates")
        .eq("organization_id", orgId)
        .eq("source_message_id", msg.source_id)
        .neq("status", "archived")
        .maybeSingle();

      // Build user message
      const userMsg = [
        `Source: ${msg.source_type}`,
        `Received: ${msg.received_at}`,
        msg.sender ? `From: ${msg.sender}` : "",
        msg.sender_email ? `Email: ${msg.sender_email}` : "",
        msg.subject ? `Subject: ${msg.subject}` : "",
        `\n---\n${msg.raw_content ?? msg.body_text ?? ""}`,
        msg.reply_to_context ? `\nReply context: ${msg.reply_to_context}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      // ── Classify with Claude (up to 3 retries) ──────────────────────────────
      let result: ClassificationResult | null = null;
      let retries = 0;
      while (retries < 3) {
        try {
          const raw = await cachedCall({
            model: "sonnet",
            systemPrompt: DEEP_CLASSIFIER_SYSTEM,
            rulesContext: rulesContext || undefined,
            userMessage: userMsg,
            maxTokens: 1024,
          });
          result = parseJsonResponse<ClassificationResult>(raw.content);
          // Back-compat: if action is missing, treat as new_task
          if (result && !result.action) {
            result.action = "new_task";
          }
          if (result) break;
        } catch (e) {
          errors.push(`classify attempt ${retries + 1} for ${msg.id}: ${e}`);
        }
        retries++;
      }

      if (!result) {
        await db
          .from("source_messages")
          .update({ processing_status: "failed", ai_classification: "error: max retries" })
          .eq("id", msg.id);
        errors.push(`failed to classify ${msg.id} after 3 retries`);
        continue;
      }

      // ── Handle: UPDATE existing open task ────────────────────────────────────
      if (result.action === "update_task" && result.task_id) {
        const targetTask = openTasks?.find((t) => t.id === result.task_id);
        if (targetTask) {
          const { data: fullTask } = await db
            .from("tasks")
            .select("updates")
            .eq("id", result.task_id)
            .eq("organization_id", orgId)
            .single();

          const currentUpdates = (fullTask?.updates as object[] | null) ?? [];
          await db.from("tasks").update({
            updates: [
              ...currentUpdates,
              {
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
                type: "ai_update",
                actor: "claude",
                content: result.update_he ?? "",
                source_message_id: msg.source_id,
                source_type: msg.source_type,
              },
            ],
            last_interaction_at: new Date().toISOString(),
          })
          .eq("id", result.task_id)
          .eq("organization_id", orgId);

          await db
            .from("source_messages")
            .update({ processing_status: "classified", ai_classification: "UPDATE" })
            .eq("id", msg.id);

          tasksUpdated++;
          itemsProcessed++;

          if ((i + 1) % BATCH_SIZE === 0) {
            await db.from("run_sessions")
              .update({ items_processed: itemsProcessed, tasks_updated: tasksUpdated })
              .eq("id", sessionId);
          }
          continue;
        }
        // If task_id not found in open tasks, fall through to new_task
        result.action = "new_task";
      }

      // ── Handle suggested rule ─────────────────────────────────────────────
      if (result.suggested_rule && (result.confidence ?? 0) >= 0.7) {
        await db.from("rules_memory").insert({
          user_id: userId,
          trigger: result.suggested_rule.trigger,
          rule_type: result.suggested_rule.rule_type,
          reason: result.suggested_rule.reason,
          is_active: false,
          created_by: "claude",
          suggestion_status: "pending",
          suggestion_confidence: result.confidence,
          suggested_by_run_id: sessionId,
        });
        rulesAdded++;
      }

      // ── Update source_message status ──────────────────────────────────────
      await db
        .from("source_messages")
        .update({
          processing_status: "classified",
          ai_classification: result.classification ?? "INFORMATIONAL",
        })
        .eq("id", msg.id);

      if (result.classification === "INFORMATIONAL") {
        informationalCount++;
        continue;
      }

      // ── Create or update task ─────────────────────────────────────────────
      actionableCount++;
      const task = result.task!;

      // Resolve project_id: use AI suggestion only if confident AND it's in this org
      const aiProjectId = result.project_id;
      const orgProjectIds = new Set((activeProjects ?? []).map((p) => p.id));
      const resolvedProjectId =
        aiProjectId && (result.project_confidence ?? 0) >= 0.7 && orgProjectIds.has(aiProjectId)
          ? aiProjectId
          : null;

      const taskPayload = {
        user_id: userId,
        organization_id: orgId,
        title: task.title_he,
        title_he: task.title_he,
        description: task.description_he,
        priority: task.priority,
        status: "inbox" as const,
        task_type: "action" as const,
        due_date: task.due_date ?? null,
        source_message_id: msg.source_id,
        related_contact: task.contact_person ?? null,
        tags: task.tags,
        ai_actions: task.suggested_actions.map((a) => ({ label: a, prompt: a })),
        ai_confidence: result.confidence ?? null,
        ai_model_used: MODELS.sonnet,
        manually_verified: false,
        project_id: resolvedProjectId,
        project_confidence: resolvedProjectId ? result.project_confidence ?? null : null,
      };

      if (existingTask) {
        await db.from("tasks").update(taskPayload)
          .eq("id", existingTask.id)
          .eq("organization_id", orgId);
        tasksUpdated++;
      } else {
        await db.from("tasks").insert(taskPayload);
        tasksCreated++;
      }

      // Checkpoint every BATCH_SIZE
      if ((i + 1) % BATCH_SIZE === 0) {
        await db.from("run_sessions").update({
          items_processed: itemsProcessed,
          tasks_created: tasksCreated,
          tasks_updated: tasksUpdated,
          actionable_count: actionableCount,
          informational_count: informationalCount,
        }).eq("id", sessionId);
      }
    }

    await closeRunSession(
      sessionId,
      errors.length === 0 ? "completed" : "partial",
      {
        items_processed: itemsProcessed,
        tasks_created: tasksCreated,
        tasks_updated: tasksUpdated,
        actionable_count: actionableCount,
        informational_count: informationalCount,
        rules_added: rulesAdded,
        errors_count: errors.length,
      },
      `Classified ${itemsProcessed} items: ${actionableCount} actionable (${tasksCreated} new, ${tasksUpdated} updated), ${informationalCount} informational.`,
      errors,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    await closeRunSession(sessionId, "failed", { errors_count: 1 }, `Fatal: ${msg}`, errors);
    throw err;
  }

  return { sessionId };
}
