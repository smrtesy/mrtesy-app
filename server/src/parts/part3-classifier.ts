/**
 * PART 3 — Deep Classifier
 *
 * Fetches source_messages with processing_status='pending', classifies each
 * with Claude (system prompt cached for ~90% cost savings), and creates/updates
 * tasks in Supabase.
 *
 * Processes in batches of 5 to keep the prompt cache warm between calls.
 */

import { db, loadRules, createRunSession, closeRunSession } from "../db";
import { cachedCall, parseJsonResponse, MODELS } from "../anthropic";
import { DEEP_CLASSIFIER_SYSTEM } from "../prompts/classifier";

const BATCH_SIZE = 5;

interface ClassificationResult {
  classification: "ACTIONABLE" | "INFORMATIONAL";
  confidence: number;
  reason_he: string;
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
  /** Max items to process in one run. Default: 50 */
  limit?: number;
}

export async function runPart3(opts: Part3Options): Promise<{ sessionId: string }> {
  const { userId, limit = 50 } = opts;
  const sessionId = await createRunSession(userId, "part3", "classifier", MODELS.sonnet);

  const errors: string[] = [];
  let tasksCreated = 0;
  let tasksUpdated = 0;
  let actionableCount = 0;
  let informationalCount = 0;
  let rulesAdded = 0;
  let itemsProcessed = 0;

  try {
    // 1. Load rules once — cached in rulesContext block
    const rules = await loadRules(userId);
    const skipRules = rules
      .filter((r) => r.rule_type === "skip" || r.rule_type === "skip_spam")
      .map((r) => `- ${r.trigger}: ${r.reason ?? r.action ?? "skip"}`)
      .join("\n");

    const writingStyleHe = rules.find((r) => r.trigger === "writing_style_he")?.action ?? "";
    const writingStyleEn = rules.find((r) => r.trigger === "writing_style_en")?.action ?? "";

    const rulesContext = [
      skipRules ? `SKIP RULES:\n${skipRules}` : "",
      writingStyleHe ? `WRITING STYLE (Hebrew):\n${writingStyleHe}` : "",
      writingStyleEn ? `WRITING STYLE (English):\n${writingStyleEn}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // 2. Fetch pending messages (FIFO)
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

    // 3. Process in batches of BATCH_SIZE (keeps cache warm for 5 min windows)
    for (let i = 0; i < pending.length; i++) {
      const msg = pending[i];
      itemsProcessed++;

      // Mark as processing to avoid double-processing in parallel runs
      await db
        .from("source_messages")
        .update({ processing_status: "processing" })
        .eq("id", msg.id);

      // Check for existing task with same source_id
      const { data: existingTask } = await db
        .from("tasks")
        .select("id, status")
        .eq("user_id", userId)
        .eq("source_message_id", msg.source_id)
        .neq("status", "archived")
        .maybeSingle();

      // Build user message for classifier
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

      // 4. Classify with Claude
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
          if (result) break;
        } catch (e) {
          errors.push(`classify attempt ${retries + 1} for ${msg.id}: ${e}`);
        }
        retries++;
      }

      if (!result) {
        await db
          .from("source_messages")
          .update({
            processing_status: "failed",
            ai_classification: "error: max retries",
          })
          .eq("id", msg.id);
        errors.push(`failed to classify ${msg.id} after 3 retries`);
        continue;
      }

      // 5. Handle suggested rule (confidence ≥ 0.7)
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

      // 6. Update source_message status
      await db
        .from("source_messages")
        .update({
          processing_status: "classified",
          ai_classification: result.classification,
        })
        .eq("id", msg.id);

      if (result.classification === "INFORMATIONAL") {
        informationalCount++;
        continue;
      }

      // 7. Create or update task
      actionableCount++;
      const task = result.task!;
      const taskPayload = {
        user_id: userId,
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
      };

      if (existingTask) {
        await db.from("tasks").update(taskPayload).eq("id", existingTask.id);
        tasksUpdated++;
      } else {
        await db.from("tasks").insert(taskPayload);
        tasksCreated++;
      }

      // 8. Checkpoint every BATCH_SIZE items
      if ((i + 1) % BATCH_SIZE === 0) {
        await db
          .from("run_sessions")
          .update({
            items_processed: itemsProcessed,
            tasks_created: tasksCreated,
            tasks_updated: tasksUpdated,
            actionable_count: actionableCount,
            informational_count: informationalCount,
          })
          .eq("id", sessionId);
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
      `Classified ${itemsProcessed} items: ${actionableCount} actionable, ${informationalCount} informational. Created ${tasksCreated} tasks.`,
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
