/**
 * POST /api/actions/execute
 * On-demand action executor — called directly from the frontend QuickAction component.
 *
 * Body: { task_id, action_type, custom_action? }
 * Returns: { result, draft_link? }
 */

import { Router, Request, Response } from "express";
import { db, loadRules } from "../../../db";
import { simpleCall } from "../../../anthropic";
import { createDraft, searchGmail, getMessage, extractEmailText } from "../../../services/gmail";
import { createCalendarEvent } from "../../../services/calendar";
import { getUserPromptContext } from "../../../lib/user-context";

const router = Router();

async function getUserId(req: Request): Promise<string | null> {
  const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

/**
 * Daily AI cost cap. Sums today's log_entries.ai_cost_usd for the user
 * and refuses to run another action once the per-user budget is reached.
 * Returns null when under budget; returns the {used, budget} object when
 * over so the caller can build a clear error response. The classifier
 * uses the same setting (user_settings.daily_ai_budget_usd), so a single
 * limit governs both background sync and on-demand actions.
 */
async function checkDailyBudget(userId: string): Promise<{ used: number; budget: number } | null> {
  const { data: settings } = await db
    .from("user_settings")
    .select("daily_ai_budget_usd")
    .eq("user_id", userId)
    .maybeSingle();
  const budget = Number(settings?.daily_ai_budget_usd) || 1.0;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data } = await db
    .from("log_entries")
    .select("ai_cost_usd")
    .eq("user_id", userId)
    .gte("created_at", todayStart.toISOString())
    .not("ai_cost_usd", "is", null);
  const used = (data ?? []).reduce((sum, r) => sum + (Number(r.ai_cost_usd) || 0), 0);
  return used >= budget ? { used, budget } : null;
}

router.post("/execute", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { task_id, action_type, custom_action } = req.body ?? {};
  if (!task_id || !action_type) {
    return res.status(400).json({ error: "task_id and action_type required" });
  }

  // Load task FIRST so a stale task_id surfaces a 404 rather than a 429 — a
  // budget message in response to a missing task is confusing UX.
  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("*")
    .eq("id", task_id)
    .eq("user_id", userId)
    .single();

  if (taskErr || !task) return res.status(404).json({ error: "Task not found" });

  // Then check today's AI spend against the per-user budget.
  const over = await checkDailyBudget(userId);
  if (over) {
    return res.status(429).json({
      error: `Daily AI budget reached (used $${over.used.toFixed(4)} of $${over.budget.toFixed(2)}). Increase it in /settings/smrttask/parameters or wait until tomorrow.`,
    });
  }

  // Load source message for context
  const { data: sourceMsg } = task.source_message_id
    ? await db
        .from("source_messages")
        .select("raw_content, body_text, sender, sender_email, subject")
        .eq("source_id", task.source_message_id)
        .eq("user_id", userId)
        .maybeSingle()
    : { data: null };

  // Load writing style rules + per-user identity (replaces single-tenant hardcoding)
  const [rules, promptCtx] = await Promise.all([
    loadRules(userId),
    getUserPromptContext(userId),
  ]);
  const styleHe = rules.find((r) => r.trigger === "writing_style_he")?.action ?? "";
  const styleEn = rules.find((r) => r.trigger === "writing_style_en")?.action ?? "";
  const userName = promptCtx.userName;

  const taskContext = [
    `Task: ${task.title_he ?? task.title}`,
    `Description: ${task.description ?? ""}`,
    `Contact: ${task.related_contact ?? ""} ${task.related_contact_email ?? ""} ${task.related_contact_phone ?? ""}`,
    `Priority: ${task.priority}`,
    `Due: ${task.due_date ?? ""}`,
  ]
    .filter((l) => !l.endsWith(": ") && !l.endsWith(":"))
    .join("\n");

  const originalContent = sourceMsg?.raw_content ?? sourceMsg?.body_text ?? "";

  // Mark task as running
  await db.from("tasks").update({ action_status: "running" }).eq("id", task_id);

  let result = "";
  let draftLink: string | undefined;
  let actionError: string | undefined;

  try {
    switch (action_type) {
      // ── Draft reply (email) ─────────────────────────────────────────────────
      case "draft_reply_he":
      case "draft_reply_en": {
        const lang = action_type.endsWith("_he") ? "Hebrew" : "English";
        const style = action_type.endsWith("_he") ? styleHe : styleEn;
        const { content } = await simpleCall(
          "sonnet",
          `Draft an email reply in ${lang} for ${userName}.\n${style ? `Writing style:\n${style}` : ""}`,
          `Original message:\n${originalContent}\n\nTask context:\n${taskContext}`,
          1024,
        );
        result = content;

        // Auto-create Gmail draft if we have sender email
        if (sourceMsg?.sender_email) {
          try {
            const draft = await createDraft(
              userId,
              sourceMsg.sender_email,
              `Re: ${sourceMsg.subject ?? task.title}`,
              content,
            );
            draftLink = draft.link;
            await db.from("tasks").update({ draft_link: draft.link }).eq("id", task_id);
          } catch {
            // draft creation failed — still return content
          }
        }
        break;
      }

      // ── Draft WhatsApp message ──────────────────────────────────────────────
      case "draft_whatsapp_he":
      case "draft_whatsapp_en": {
        const lang = action_type.endsWith("_he") ? "Hebrew" : "English";
        const style = action_type.endsWith("_he") ? styleHe : styleEn;
        const { content } = await simpleCall(
          "sonnet",
          `Draft a WhatsApp message in ${lang} for ${userName}. Keep it concise and conversational.\n${style ? `Style:\n${style}` : ""}`,
          `Context:\n${taskContext}\n\nOriginal:\n${originalContent}`,
          512,
        );
        result = content;
        break;
      }

      // ── Summarize history ───────────────────────────────────────────────────
      case "summarize_history": {
        const contact = task.related_contact ?? task.related_contact_email ?? "";
        let history = "";

        if (contact) {
          const msgs = await searchGmail(userId, `from:${contact} OR to:${contact}`, 20);
          const snippets: string[] = [];
          for (const { id } of msgs.slice(0, 8)) {
            try {
              const msg = await getMessage(userId, id);
              const { subject, date, body } = extractEmailText(msg as Parameters<typeof extractEmailText>[0]);
              snippets.push(`[${date}] ${subject}: ${body.slice(0, 200)}`);
            } catch { /* skip */ }
          }
          history = snippets.join("\n---\n");
        }

        const { content } = await simpleCall(
          "sonnet",
          `Summarize communication history with ${contact} for ${userName}. Hebrew. 200-400 words. Include topics, status, open items.`,
          history || `No email history found. Task context:\n${taskContext}`,
          800,
        );
        result = content;
        break;
      }

      // ── Find in emails ──────────────────────────────────────────────────────
      case "find_in_emails": {
        const keywords = (custom_action ?? task.title).split(/\s+/).slice(0, 5).join(" ");
        const msgs = await searchGmail(userId, keywords, 10);
        const found: string[] = [];
        for (const { id } of msgs.slice(0, 5)) {
          try {
            const msg = await getMessage(userId, id);
            const { subject, from, date, body } = extractEmailText(msg as Parameters<typeof extractEmailText>[0]);
            found.push(`[${date}] From: ${from}\nSubject: ${subject}\n${body.slice(0, 300)}`);
          } catch { /* skip */ }
        }
        result = found.length
          ? `Found ${found.length} relevant emails:\n\n${found.join("\n\n---\n\n")}`
          : "No relevant emails found.";
        break;
      }

      // ── Check past handling ─────────────────────────────────────────────────
      case "check_past_handling": {
        const { data: pastTasks } = await db
          .from("tasks")
          .select("title_he, description, status, completed_at, created_at")
          .eq("user_id", userId)
          .in("status", ["completed", "archived"])
          .ilike("title_he", `%${(task.related_contact ?? "").split(" ")[0]}%`)
          .order("created_at", { ascending: false })
          .limit(10);

        if (!pastTasks?.length) {
          result = "לא נמצאו משימות דומות בעבר.";
        } else {
          const list = pastTasks
            .map((t) => `- ${t.title_he} (${t.status}, ${t.completed_at?.slice(0, 10) ?? t.created_at?.slice(0, 10)})`)
            .join("\n");
          result = `נמצאו ${pastTasks.length} משימות דומות בעבר:\n\n${list}`;
        }
        break;
      }

      // ── Set reminder ────────────────────────────────────────────────────────
      case "set_reminder": {
        const timeStr = custom_action ?? "9:00 tomorrow";
        const reminderDate = new Date();
        reminderDate.setDate(reminderDate.getDate() + 1);
        reminderDate.setHours(9, 0, 0, 0);

        try {
          const endDate = new Date(reminderDate.getTime() + 30 * 60 * 1000);
          await createCalendarEvent(
            userId,
            `תזכורת: ${task.title_he ?? task.title}`,
            reminderDate.toISOString(),
            endDate.toISOString(),
            task.description ?? undefined,
          );
          result = `תזכורת נוצרה ל-${reminderDate.toLocaleDateString("he-IL")} ${reminderDate.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`;
        } catch (e) {
          result = `לא ניתן ליצור אירוע ב-Calendar: ${e}. זמן מוצע: ${timeStr}`;
        }
        break;
      }

      // ── Call preparation ────────────────────────────────────────────────────
      case "call_preparation": {
        const { content } = await simpleCall(
          "sonnet",
          `Prepare ${userName} for a phone call with ${task.related_contact ?? "the contact"}. Output in Hebrew:
- Purpose of call
- Key points to mention
- Questions to ask
- Anticipated objections + responses
- Goal`,
          taskContext,
          1024,
        );
        result = content;
        break;
      }

      // ── Financial advisor ───────────────────────────────────────────────────
      case "financial_advisor": {
        const { content } = await simpleCall(
          "opus",
          `You are a financial advisor for ${userName}. Analyze and recommend optimal course of action.
Output in Hebrew:
- Analysis (2-3 paragraphs)
- Recommended approach
- Specific numbers/amounts if relevant
- Risks
- Draft action (email/call prep)`,
          `Context:\n${taskContext}\n\nOriginal message:\n${originalContent}`,
          2048,
        );
        result = content;
        break;
      }

      // ── Draft settlement request ────────────────────────────────────────────
      case "draft_settlement_request": {
        const { content } = await simpleCall(
          "opus",
          `Draft a formal settlement request email in Hebrew for ${userName}.
${styleHe ? `Writing style:\n${styleHe}` : ""}
Be professional, factual, and constructive.`,
          `Task context:\n${taskContext}\n\nOriginal:\n${originalContent}`,
          1500,
        );
        result = content;
        if (sourceMsg?.sender_email) {
          try {
            const draft = await createDraft(
              userId,
              sourceMsg.sender_email,
              `בקשת פשרה — ${sourceMsg.subject ?? task.title}`,
              content,
            );
            draftLink = draft.link;
            await db.from("tasks").update({ draft_link: draft.link }).eq("id", task_id);
          } catch { /* return content anyway */ }
        }
        break;
      }

      // ── Custom ──────────────────────────────────────────────────────────────
      case "custom": {
        if (!custom_action) {
          result = "Please specify what to do in the custom action field.";
          break;
        }
        const { content } = await simpleCall(
          "sonnet",
          `You are an AI assistant for ${userName}. Perform the requested action.`,
          `Task context:\n${taskContext}\n\nRequest:\n${custom_action}\n\nOriginal message:\n${originalContent}`,
          1500,
        );
        result = content;
        break;
      }

      // Unknown action_type — fall through to the generic free-form path.
      // ai-process produces ai_actions with Hebrew labels and free-form
      // prompts; the classifier doesn't constrain itself to the 12 cases
      // above. Route those through Sonnet with the provided custom_action
      // so the button actually does something instead of stalling.
      default: {
        if (!custom_action) {
          result = `Action "${action_type}" needs a prompt and none was provided.`;
          break;
        }
        const { content, costUsd } = await simpleCall(
          "sonnet",
          `You are an AI assistant for ${userName}. Run the requested task. Match the user's writing style if a sample is provided in the context.`,
          `Task context:\n${taskContext}\n\nOriginal message:\n${originalContent}\n\nRequest:\n${custom_action}`,
          1500,
        );
        result = content;
        // Persist the cost so checkDailyBudget sees this spend. The 11 known
        // cases above don't log cost yet — pre-existing gap, separate fix.
        await db.from("log_entries").insert({
          user_id: userId,
          category: "ai_action",
          status: "ok",
          task_id,
          task_title: task.title_he ?? task.title,
          task_action: action_type,
          ai_model_used: "claude-sonnet-4-6",
          ai_cost_usd: costUsd,
        });
      }
    }

    // Save result to task + ai_generated_content
    const existingContent = (task.ai_generated_content as object[] | null) ?? [];
    const newEntry = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      action_label: action_type,
      result,
      draft_url: draftLink,
      model: action_type === "financial_advisor" ? "claude-opus-4-7" : "claude-sonnet-4-6",
    };

    await db
      .from("tasks")
      .update({
        action_status: "completed",
        action_result: result.slice(0, 2000),
        action_completed_at: new Date().toISOString(),
        draft_link: draftLink ?? task.draft_link,
        ai_generated_content: [...existingContent, newEntry],
      })
      .eq("id", task_id);

    // Log to action_history
    await db.from("action_history").insert({
      user_id: userId,
      task_id,
      action_type,
      status: "completed",
      completed_at: new Date().toISOString(),
      result: result.slice(0, 1000),
    });

    return res.json({ result, draft_link: draftLink });
  } catch (err) {
    actionError = err instanceof Error ? err.message : String(err);

    const retryCount = (task.action_retry_count ?? 0) + 1;
    await db
      .from("tasks")
      .update({
        action_status: retryCount >= 3 ? "failed_permanently" : "failed",
        action_error: actionError,
        action_retry_count: retryCount,
      })
      .eq("id", task_id);

    await db.from("action_history").insert({
      user_id: userId,
      task_id,
      action_type,
      status: "failed",
      error: actionError,
    });

    return res.status(500).json({ error: actionError });
  }
});

export default router;
