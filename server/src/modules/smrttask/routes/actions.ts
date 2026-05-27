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

const DEFAULT_DAILY_BUDGET_USD = 10;

async function getUserId(req: Request): Promise<string | null> {
  const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

async function getDailyBudget(userId: string): Promise<number> {
  const { data } = await db
    .from("user_settings")
    .select("daily_ai_budget_usd")
    .eq("user_id", userId)
    .maybeSingle();
  const raw = data?.daily_ai_budget_usd;
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_BUDGET_USD;
}

async function getSpentToday(userId: string): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data } = await db
    .from("log_entries")
    .select("ai_cost_usd")
    .eq("user_id", userId)
    .gte("created_at", todayStart.toISOString())
    .not("ai_cost_usd", "is", null);
  return (data ?? []).reduce(
    (sum, row) => sum + (Number((row as { ai_cost_usd: number | null }).ai_cost_usd) || 0),
    0,
  );
}

router.post("/execute", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { task_id, action_type, custom_action } = req.body ?? {};
  if (!task_id || !action_type) {
    return res.status(400).json({ error: "task_id and action_type required" });
  }

  // Load task
  const { data: task, error: taskErr } = await db
    .from("tasks")
    .select("*")
    .eq("id", task_id)
    .eq("user_id", userId)
    .single();

  if (taskErr || !task) return res.status(404).json({ error: "Task not found" });

  // Daily budget gate — abort before any paid API call.
  const budget = await getDailyBudget(userId);
  const spentBefore = await getSpentToday(userId);
  if (spentBefore >= budget) {
    return res.status(429).json({
      error: `התקציב היומי לבינה (${budget.toFixed(2)}$) הסתיים. כבר נוצלו ${spentBefore.toFixed(2)}$. נסה שוב מחר, או הגדל את התקציב בהגדרות.`,
      code: "BUDGET_EXCEEDED",
      spent_usd: spentBefore,
      budget_usd: budget,
    });
  }

  // Load source message for context
  const { data: sourceMsg } = task.source_message_id
    ? await db
        .from("source_messages")
        .select("raw_content, body_text, sender, sender_email, subject, source_type, metadata")
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
  let totalCost = 0;
  const startedAt = Date.now();
  const modelUsed = action_type === "financial_advisor" || action_type === "draft_settlement_request"
    ? "claude-opus-4-7"
    : "claude-sonnet-4-6";

  try {
    switch (action_type) {
      // ── Draft reply (email) ─────────────────────────────────────────────────
      case "draft_reply_he":
      case "draft_reply_en": {
        // Language is driven by the ORIGINAL message, not the action label —
        // an English inbound must get an English reply even if the classifier
        // suggested draft_reply_he. Both style guides are supplied so the model
        // matches the one for whichever language it writes in.
        const { content, costUsd } = await simpleCall(
          "sonnet",
          `Draft an email reply for ${userName}. CRITICAL: write the reply in the SAME language as the original message below — if the original is in English reply in English, if in Hebrew reply in Hebrew. Match the writing style for that language.${styleHe ? `\n\nHebrew style:\n${styleHe}` : ""}${styleEn ? `\n\nEnglish style:\n${styleEn}` : ""}`,
          `Original message:\n${originalContent}\n\nTask context:\n${taskContext}`,
          1024,
        );
        result = content;
        totalCost += costUsd;

        // Auto-create Gmail draft as a threaded reply if we have sender email
        if (sourceMsg?.sender_email) {
          try {
            const meta = (sourceMsg.metadata as { threadId?: string; rfc822MsgId?: string } | null) ?? null;
            const draft = await createDraft(
              userId,
              sourceMsg.sender_email,
              `Re: ${sourceMsg.subject ?? task.title}`,
              content,
              meta?.threadId,
              meta?.rfc822MsgId,
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
        const { content, costUsd } = await simpleCall(
          "sonnet",
          `Draft a WhatsApp message in ${lang} for ${userName}. Keep it concise and conversational.\n${style ? `Style:\n${style}` : ""}`,
          `Context:\n${taskContext}\n\nOriginal:\n${originalContent}`,
          512,
        );
        result = content;
        totalCost += costUsd;
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

        const { content, costUsd } = await simpleCall(
          "sonnet",
          `Summarize communication history with ${contact} for ${userName}. Hebrew. 200-400 words. Include topics, status, open items.`,
          history || `No email history found. Task context:\n${taskContext}`,
          800,
        );
        result = content;
        totalCost += costUsd;
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
        const { content, costUsd } = await simpleCall(
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
        totalCost += costUsd;
        break;
      }

      // ── Financial advisor ───────────────────────────────────────────────────
      case "financial_advisor": {
        const { content, costUsd } = await simpleCall(
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
        totalCost += costUsd;
        break;
      }

      // ── Draft settlement request ────────────────────────────────────────────
      case "draft_settlement_request": {
        const { content, costUsd } = await simpleCall(
          "opus",
          `Draft a formal settlement request email in Hebrew for ${userName}.
${styleHe ? `Writing style:\n${styleHe}` : ""}
Be professional, factual, and constructive.`,
          `Task context:\n${taskContext}\n\nOriginal:\n${originalContent}`,
          1500,
        );
        result = content;
        totalCost += costUsd;
        if (sourceMsg?.sender_email) {
          try {
            const meta = (sourceMsg.metadata as { threadId?: string; rfc822MsgId?: string } | null) ?? null;
            const draft = await createDraft(
              userId,
              sourceMsg.sender_email,
              `בקשת פשרה — ${sourceMsg.subject ?? task.title}`,
              content,
              meta?.threadId,
              meta?.rfc822MsgId,
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
        const { content, costUsd } = await simpleCall(
          "sonnet",
          `You are an AI assistant for ${userName}. Perform the requested action.`,
          `Task context:\n${taskContext}\n\nRequest:\n${custom_action}\n\nOriginal message:\n${originalContent}`,
          1500,
        );
        result = content;
        totalCost += costUsd;
        break;
      }

      default: {
        // Custom / AI-suggested action — the classifier emits free-form labels
        // (e.g. "טיוטת קבלה לפרנצ'סקה סקולס") that aren't in the fixed switch
        // above. Treat the label itself (or the explicit custom_action) as the
        // LLM instruction and run the generic custom path.
        const instruction = (typeof custom_action === "string" && custom_action.trim())
          ? custom_action
          : String(action_type);
        const { content, costUsd } = await simpleCall(
          "sonnet",
          `You are an AI assistant for ${userName}. Perform the requested action and return the deliverable directly (no preamble). Reply in Hebrew unless the request is clearly in another language.`,
          `Task context:\n${taskContext}\n\nRequest:\n${instruction}\n\nOriginal message:\n${originalContent}`,
          1500,
        );
        result = content;
        totalCost += costUsd;
        break;
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
      model: modelUsed,
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

    // Log cost to log_entries so the daily budget gate sees this run.
    if (totalCost > 0) {
      await db.from("log_entries").insert({
        user_id: userId,
        category: "ai_action",
        status: "ok",
        task_id,
        task_title: task.title_he ?? task.title,
        task_action: action_type,
        ai_model_used: modelUsed,
        ai_cost_usd: totalCost,
        processing_duration_ms: Date.now() - startedAt,
      });
    }

    const newSpent = spentBefore + totalCost;
    return res.json({
      result,
      draft_link: draftLink,
      budget: { spent_usd: newSpent, budget_usd: budget, cost_this_action_usd: totalCost },
    });
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

    // Still log any cost incurred before the failure — partial calls bill too.
    if (totalCost > 0) {
      await db.from("log_entries").insert({
        user_id: userId,
        level: "error",
        category: "ai_action",
        status: "failed",
        task_id,
        task_title: task.title_he ?? task.title,
        task_action: action_type,
        ai_model_used: modelUsed,
        ai_cost_usd: totalCost,
        processing_duration_ms: Date.now() - startedAt,
        error_message: actionError,
      });
    }

    return res.status(500).json({ error: actionError });
  }
});

export default router;
