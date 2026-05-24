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
import { cachedCall, parseJsonResponse, MODELS, type ModelKey } from "../../../anthropic";
import { buildDeepClassifierSystem } from "../../../prompts/classifier";
import { getUserPromptContext } from "../../../lib/user-context";
import { loadPrompt } from "../../../lib/prompt-loader";

const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_RULE_THRESHOLD = 0.7;
const DEFAULT_PROJECT_MATCH_THRESHOLD = 0.7;
const KNOWN_MODELS: ReadonlySet<ModelKey> = new Set(["haiku", "sonnet", "opus"]);

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
    checklist?: string[];
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

  // Load per-user knobs (model + thresholds + batch size). Each column is
  // nullable; null = use the hardcoded default. See migration 20260519000001.
  const { data: settings } = await db
    .from("user_settings")
    .select("smrttask_classifier_model, smrttask_rule_threshold, smrttask_project_match_threshold, smrttask_batch_size")
    .eq("user_id", userId)
    .maybeSingle();

  const modelKey: ModelKey = settings?.smrttask_classifier_model && KNOWN_MODELS.has(settings.smrttask_classifier_model as ModelKey)
    ? (settings.smrttask_classifier_model as ModelKey)
    : "sonnet";
  const ruleThreshold = typeof settings?.smrttask_rule_threshold === "number"
    ? settings.smrttask_rule_threshold : DEFAULT_RULE_THRESHOLD;
  const projectMatchThreshold = typeof settings?.smrttask_project_match_threshold === "number"
    ? settings.smrttask_project_match_threshold : DEFAULT_PROJECT_MATCH_THRESHOLD;
  const batchSize = typeof settings?.smrttask_batch_size === "number" && settings.smrttask_batch_size > 0
    ? settings.smrttask_batch_size : DEFAULT_BATCH_SIZE;

  const sessionId = await createRunSession(userId, "part3", "classifier", MODELS[modelKey]);

  const errors: string[] = [];
  let tasksCreated = 0;
  let tasksUpdated = 0;
  let actionableCount = 0;
  let informationalCount = 0;
  let rulesAdded = 0;
  let itemsProcessed = 0;

  try {
    // ── 0. Per-tenant identity used in the system prompt ─────────────────────
    // DB-stored version (editable in /admin/apps/smrttask/prompts) takes precedence;
    // falls back to the hardcoded default so the pipeline always has a valid prompt.
    const promptCtx = await getUserPromptContext(userId, orgId);
    const systemPrompt =
      (await loadPrompt(userId, "deep_classifier", promptCtx)) ??
      buildDeepClassifierSystem(promptCtx);

    // ── 1. Load rules (cached in rulesContext) ────────────────────────────────
    const rules = await loadRules(userId);
    const skipRules = rules
      .filter((r) => r.rule_type === "skip" || r.rule_type === "skip_spam")
      .map((r) => `- ${r.trigger}: ${r.reason ?? r.action ?? "skip"}`)
      .join("\n");
    const writingStyleHe = rules.find((r) => r.trigger === "writing_style_he")?.action ?? "";
    const writingStyleEn = rules.find((r) => r.trigger === "writing_style_en")?.action ?? "";

    // ── 2. Load open tasks for update-threading (scoped to active org) ───────
    // Include both verified and unverified (pending-approval) tasks so Claude
    // can detect follow-ups to messages that arrived moments ago and haven't
    // been approved yet — without this, a reply arriving before approval
    // creates a duplicate task instead of appending to the existing one.
    // Join source_messages so each open-task line can also carry the original
    // sender display name + received_at + age. Used by the classifier's
    // "transactional follow-up" rule: when a new automated email arrives
    // with sender "<Person> via <Service>" (DocuSign, Adobe Sign, Bill.com,
    // HelloSign, ...), it can match an open task whose original sender was
    // <Person> and whose title references <Service> — preventing the
    // heads-up-then-actual-email pair from creating two duplicate tasks.
    const { data: openTasks } = await db
      .from("tasks")
      .select("id, title_he, title, description, related_contact, related_contact_email, related_contact_phone, tags, source_message_id, source_messages(sender, received_at)")
      .eq("organization_id", orgId)
      .in("status", ["inbox", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(30);

    const openTasksBlock = (openTasks ?? []).length > 0
      ? "OPEN TASKS (check for follow-ups before creating new):\n" +
        (openTasks ?? []).map((t) => {
          // Supabase returns the joined row as either a single object or an
          // array depending on the relationship cardinality; normalize.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sm = Array.isArray(t.source_messages) ? t.source_messages[0] : (t.source_messages as any);
          const originalSender = sm?.sender ?? "";
          const ageHrs = sm?.received_at
            ? Math.max(0, Math.round((Date.now() - new Date(sm.received_at as string).getTime()) / 3_600_000))
            : null;
          const ageHint = ageHrs != null ? ` | age_hrs: ${ageHrs}` : "";
          return `[id:${t.id}] ${t.title_he ?? t.title} | contact: ${t.related_contact ?? ""} ${t.related_contact_email ?? ""} ${t.related_contact_phone ?? ""} | original_sender: ${originalSender} | tags: ${(t.tags as string[] | null)?.join(",") ?? ""}${ageHint}`;
        }).join("\n")
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
    // Track tasks created within this Part3 run so subsequent messages in the
    // same batch see them as "open tasks" — otherwise duplicates produced
    // back-to-back (e.g. the same Google Workspace storage alert delivered
    // to two of the user's aliases) each turn into their own task because
    // the openTasks query ran once at the top of the loop and is stale.
    const batchCreated: Array<{
      id: string;
      title_he: string;
      sender: string;
      sender_email: string;
      subject: string;
    }> = [];

    for (let i = 0; i < pending.length; i++) {
      const msg = pending[i];
      itemsProcessed++;

      await db
        .from("source_messages")
        .update({ processing_status: "processing" })
        .eq("id", msg.id);

      // Check for existing task linked to this source_message (dedup — scoped to active org).
      // tasks.source_message_id is a UUID FK → source_messages.id, so use msg.id, not msg.source_id.
      const { data: existingTask } = await db
        .from("tasks")
        .select("id, status, updates")
        .eq("organization_id", orgId)
        .eq("source_message_id", msg.id)
        .neq("status", "archived")
        .maybeSingle();

      // Fresh "just created in this batch" section — appended to the user
      // message (NOT the cached rulesContext) so the prompt cache stays
      // warm. The classifier's Step 1 already knows to bias toward
      // update_task when an open task matches; this just gives it the
      // tasks that aren't in the snapshot-time openTasks yet.
      const batchBlock = batchCreated.length > 0
        ? "JUST CREATED IN THIS BATCH (treat as open tasks for update_task matching):\n" +
          batchCreated.map((t) =>
            `[id:${t.id}] ${t.title_he} | from: ${t.sender} <${t.sender_email}> | subject: ${t.subject}`
          ).join("\n") + "\n\n"
        : "";

      // Build user message
      const userMsg = [
        batchBlock,
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
            model: modelKey,
            systemPrompt,
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
          // NO-OP UPDATE GUARD: the prompt instructs the classifier to return
          // update_he="" when the new message adds nothing new. In that case
          // we still mark the source_message as classified (so it isn't
          // re-processed) and bump last_interaction_at (the user did engage
          // on the thread), but we DON'T append a noise entry to updates[].
          const updateText = (result.update_he ?? "").trim();
          const isNoOp = updateText.length === 0;

          if (isNoOp) {
            await db.from("tasks").update({
              last_interaction_at: new Date().toISOString(),
            })
              .eq("id", result.task_id)
              .eq("organization_id", orgId);
            await db
              .from("source_messages")
              .update({ processing_status: "classified", ai_classification: "UPDATE_NOOP" })
              .eq("id", msg.id);
            tasksUpdated++;
            if ((i + 1) % batchSize === 0) {
              await db.from("run_sessions")
                .update({ items_processed: itemsProcessed, tasks_updated: tasksUpdated })
                .eq("id", sessionId);
            }
            continue;
          }

          const { data: fullTask } = await db
            .from("tasks")
            .select("updates")
            .eq("id", result.task_id)
            .eq("organization_id", orgId)
            .single();

          const currentUpdates = (fullTask?.updates as object[] | null) ?? [];
          const { error: appendErr } = await db.from("tasks").update({
            updates: [
              ...currentUpdates,
              {
                id: crypto.randomUUID(),
                created_at: new Date().toISOString(),
                type: "ai_update",
                actor: "claude",
                content: updateText,
                source_message_id: msg.id,
                source_type: msg.source_type,
              },
            ],
            last_interaction_at: new Date().toISOString(),
          })
          .eq("id", result.task_id)
          .eq("organization_id", orgId);

          if (appendErr) {
            errors.push(`append update to task ${result.task_id}: ${appendErr.message}`);
          } else {
            await db
              .from("source_messages")
              .update({ processing_status: "classified", ai_classification: "UPDATE" })
              .eq("id", msg.id);
            tasksUpdated++;
          }

          if ((i + 1) % batchSize === 0) {
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
      if (result.suggested_rule && (result.confidence ?? 0) >= ruleThreshold) {
        const { error: ruleInsertErr } = await db.from("rules_memory").insert({
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
        if (!ruleInsertErr) rulesAdded++;
      }

      if (result.classification === "INFORMATIONAL") {
        informationalCount++;
        await db
          .from("source_messages")
          .update({ processing_status: "classified", ai_classification: "INFORMATIONAL" })
          .eq("id", msg.id);
        continue;
      }

      // ── Create or update task ─────────────────────────────────────────────
      // Mark source_message classified ONLY after a successful task write so that
      // a DB error on insert doesn't orphan the message in a permanent "classified"
      // state where neither Part3 nor Part2 will ever retry it.
      actionableCount++;
      const task = result.task!;

      // Resolve project_id: use AI suggestion only if confident AND it's in this org
      const aiProjectId = result.project_id;
      const orgProjectIds = new Set((activeProjects ?? []).map((p) => p.id));
      const resolvedProjectId =
        aiProjectId && (result.project_confidence ?? 0) >= projectMatchThreshold && orgProjectIds.has(aiProjectId)
          ? aiProjectId
          : null;

      // For WhatsApp threads Part2 stored the wa.me URL and phone in the source_message.
      // Carry them through to the task so TaskCard shows the link icon and the
      // suggestions page can render the contact phone.
      const isWhatsapp = msg.source_type === "whatsapp";

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
        // tasks.source_message_id is a UUID FK → source_messages.id; use msg.id, not msg.source_id
        source_message_id: msg.id,
        related_contact: task.contact_person ?? (isWhatsapp ? (msg as any).sender ?? null : null),
        related_contact_phone: isWhatsapp ? (msg as any).reply_to_context ?? null : null,
        source_link: isWhatsapp ? (msg as any).source_url ?? null : null,
        tags: task.tags,
        ai_actions: task.suggested_actions.map((a) => ({ label: a, prompt: a })),
        ai_confidence: result.confidence ?? null,
        ai_model_used: MODELS[modelKey],
        manually_verified: false,
        project_id: resolvedProjectId,
        project_confidence: resolvedProjectId ? result.project_confidence ?? null : null,
      };

      // Build the initial checklist from AI-suggested sub-items. ONLY applied
      // on insert — we don't overwrite a checklist the user may have edited on
      // a re-classification of the same source_message.
      const aiChecklistTitles = Array.isArray(task.checklist)
        ? task.checklist.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        : [];
      const aiChecklist = aiChecklistTitles.map((title) => ({
        id: crypto.randomUUID(),
        title: title.trim(),
        done: false,
        created_at: new Date().toISOString(),
        completed_at: null,
        created_by: "ai" as const,
      }));

      let taskWriteOk = false;
      let createdTaskId: string | null = null;
      if (existingTask) {
        const { error: updateErr } = await db.from("tasks").update(taskPayload)
          .eq("id", existingTask.id)
          .eq("organization_id", orgId);
        if (updateErr) errors.push(`update task ${existingTask.id}: ${updateErr.message}`);
        else { tasksUpdated++; taskWriteOk = true; }
      } else {
        const insertPayload = aiChecklist.length > 0
          ? { ...taskPayload, checklist: aiChecklist }
          : taskPayload;
        const { data: inserted, error: insertErr } = await db
          .from("tasks")
          .insert(insertPayload)
          .select("id")
          .single();
        if (insertErr) errors.push(`insert task for source_msg ${msg.id}: ${insertErr.message}`);
        else { tasksCreated++; taskWriteOk = true; createdTaskId = inserted?.id ?? null; }
      }

      // Record the new task in the in-memory batch list so subsequent
      // messages in this same Part3 run see it via the JUST CREATED block
      // built into userMsg — prevents back-to-back duplicates (same alert
      // delivered to two of the user's aliases, e.g. G335/G336 storage
      // warnings → T234/T235).
      if (createdTaskId && !existingTask) {
        batchCreated.push({
          id: createdTaskId,
          title_he: task.title_he,
          sender: msg.sender ?? "",
          sender_email: msg.sender_email ?? "",
          subject: msg.subject ?? "",
        });
      }

      // Only mark classified once the task row is committed; on failure leave as
      // "processing" so the next run can retry (processing_lock_at handles stale locks).
      if (taskWriteOk) {
        await db
          .from("source_messages")
          .update({ processing_status: "classified", ai_classification: result.classification })
          .eq("id", msg.id);
      } else {
        await db
          .from("source_messages")
          .update({ processing_status: "pending" })
          .eq("id", msg.id);
      }

      // Checkpoint every batchSize
      if ((i + 1) % batchSize === 0) {
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
