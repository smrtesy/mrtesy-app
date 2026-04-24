/**
 * PART 2 — WhatsApp Conversation Analyzer
 *
 * Reads messages from a Google Sheet (written by Dualhook), groups them into
 * conversation threads, classifies each thread with Claude, and creates tasks
 * in Supabase for threads that need attention.
 *
 * Checkpoint: stored in sync_state.checkpoint as the last processed Sheets row
 * index, so re-runs skip already-processed rows.
 */

import { google } from "googleapis";
import { db, loadRules, createRunSession, closeRunSession, updateSyncState } from "../db";
import { cachedCall, parseJsonResponse, MODELS } from "../anthropic";
import { getOAuthClient } from "../services/token-refresh";
import { WHATSAPP_CLASSIFIER_SYSTEM } from "../prompts/whatsapp";

const SHEET_ID = process.env.WHATSAPP_SHEET_ID!;
const SHEET_TAB = process.env.WHATSAPP_SHEET_TAB ?? "Messages";

// Column indices (0-based) — matches the 19-column structure from Dualhook
const COL = {
  TIMESTAMP:       0,
  FROM_PHONE:      1,
  FROM_NAME:       2,
  CHAT_ID:         3,
  MESSAGE:         4,
  MESSAGE_TYPE:    5,
  DIRECTION:       6,  // 'incoming' | 'outgoing'
  STATUS:          7,
  MEDIA_URL:       8,
  CAPTION:         9,
  QUOTED_MSG:      10,
  QUOTED_PHONE:    11,
  CHAT_NAME:       12,
  IS_GROUP:        13,
  GROUP_MEMBERS:   14,
  DEVICE:          15,
  WEBHOOK_ID:      16,
  PROCESSING_STATUS: 17,
  ROW_INDEX:       18,
} as const;

interface SheetRow {
  rowIndex: number;
  timestamp: Date;
  fromPhone: string;
  fromName: string;
  chatId: string;
  message: string;
  messageType: string;
  direction: "incoming" | "outgoing";
  chatName: string;
  isGroup: boolean;
}

interface Classification {
  status: "NEEDS_RESPONSE" | "WAITING_REPLY" | "PERSONAL_REMINDER" | "CLOSED" | "NOISE";
  topic: string;
  urgency: "urgent" | "high" | "medium" | "low";
  last_msg_summary: string;
  suggested_actions: string[];
  ideal_response_time: "morning" | "afternoon" | "evening" | "none";
  context_summary: string;
}

export interface Part2Options {
  userId: string;
  /** How many hours back to look. Default: 48. First run: use 168 (7 days). */
  lookbackHours?: number;
  /** If true, re-process messages even if already checkpointed */
  force?: boolean;
}

export async function runPart2(opts: Part2Options): Promise<{ sessionId: string }> {
  const { userId, lookbackHours = 48, force = false } = opts;
  const sessionId = await createRunSession(userId, "part2", "whatsapp", MODELS.sonnet);

  const errors: string[] = [];
  let tasksCreated = 0;
  let itemsProcessed = 0;
  let rulesAdded = 0;

  try {
    // 1. Load bot/spam rules
    const rules = await loadRules(userId);
    const botPhones = new Set(
      rules
        .filter((r) => r.rule_type === "bot" && r.category === "bot")
        .map((r) => r.trigger.replace(/^WhatsApp sender = /, "").trim()),
    );

    // 2. Load current checkpoint (last processed row index)
    const { data: syncStateRow } = await db
      .from("sync_state")
      .select("checkpoint")
      .eq("user_id", userId)
      .eq("source", "whatsapp")
      .single();

    const lastRow = force ? 0 : parseInt(syncStateRow?.checkpoint ?? "0", 10);

    // 3. Authenticate with Google Sheets (uses gmail_calendar credential which includes sheets.readonly)
    const auth = await getOAuthClient(userId, "gmail_calendar");
    const sheets = google.sheets({ version: "v4", auth });

    // 4. Fetch new rows from the Sheet
    const sheetsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A2:S`,
    });

    const allRows = sheetsResponse.data.values ?? [];
    const cutoffTime = Date.now() - lookbackHours * 60 * 60 * 1000;

    const newRows: SheetRow[] = [];
    let maxRowIndex = lastRow;

    for (const row of allRows) {
      const rowIndex = parseInt(row[COL.ROW_INDEX] ?? "0", 10) || 0;
      if (!force && rowIndex <= lastRow) continue;

      const ts = new Date(row[COL.TIMESTAMP] ?? "");
      if (isNaN(ts.getTime()) || ts.getTime() < cutoffTime) continue;

      const messageType = (row[COL.MESSAGE_TYPE] ?? "").toLowerCase();
      if (messageType === "reaction") continue; // skip emoji reactions

      const fromPhone = row[COL.FROM_PHONE] ?? "";
      if (botPhones.has(fromPhone)) continue;

      newRows.push({
        rowIndex,
        timestamp: ts,
        fromPhone,
        fromName: row[COL.FROM_NAME] ?? fromPhone,
        chatId: row[COL.CHAT_ID] ?? fromPhone,
        message: row[COL.MESSAGE] ?? row[COL.CAPTION] ?? "",
        messageType,
        direction: ((row[COL.DIRECTION] ?? "incoming").toLowerCase()) as "incoming" | "outgoing",
        chatName: row[COL.CHAT_NAME] ?? row[COL.FROM_NAME] ?? fromPhone,
        isGroup: (row[COL.IS_GROUP] ?? "").toLowerCase() === "true",
      });

      if (rowIndex > maxRowIndex) maxRowIndex = rowIndex;
    }

    // 5. Group by chatId, keep last 20 messages
    const threads = new Map<string, SheetRow[]>();
    for (const row of newRows) {
      if (!threads.has(row.chatId)) threads.set(row.chatId, []);
      threads.get(row.chatId)!.push(row);
    }

    // Also load previous messages for context (up to 20 total)
    // We do this by querying source_messages for existing whatsapp threads
    const chatIds = [...threads.keys()];
    const { data: existingMsgs } = chatIds.length
      ? await db
          .from("source_messages")
          .select("source_id, sender, body_text, received_at, metadata")
          .eq("user_id", userId)
          .eq("source_type", "whatsapp")
          .in("source_id", chatIds.map((id) => `wa:${id}`))
          .order("received_at", { ascending: false })
          .limit(500)
      : { data: [] };

    // Build context map from existing messages
    const existingContext = new Map<string, { text: string; direction: string; ts: string }[]>();
    for (const msg of existingMsgs ?? []) {
      const chatId = (msg.source_id as string).replace(/^wa:/, "");
      if (!existingContext.has(chatId)) existingContext.set(chatId, []);
      existingContext.get(chatId)!.push({
        text: msg.body_text ?? "",
        direction: (msg.metadata as Record<string,string> | null)?.direction ?? "incoming",
        ts: msg.received_at ?? "",
      });
    }

    // 6. Process each thread
    for (const [chatId, msgs] of threads.entries()) {
      itemsProcessed++;

      // Persist new messages to source_messages (dedup by source_id + received_at)
      for (const msg of msgs) {
        const sourceId = `wa:${chatId}`;
        await db.from("source_messages").upsert(
          {
            user_id: userId,
            source_type: "whatsapp",
            source_id: sourceId,
            sender: msg.fromName,
            sender_email: null,
            body_text: msg.message,
            received_at: msg.timestamp.toISOString(),
            processing_status: "pending",
            metadata: {
              direction: msg.direction,
              fromPhone: msg.fromPhone,
              chatName: msg.chatName,
              isGroup: msg.isGroup,
              rowIndex: msg.rowIndex,
            },
          },
          { onConflict: "user_id,source_type,source_id" },
        );
      }

      // Build conversation context: last 20 messages combined
      const context = [
        ...(existingContext.get(chatId) ?? [])
          .slice(0, 10)
          .map((m) => ({ dir: m.direction, text: m.text, ts: m.ts })),
        ...msgs.map((m) => ({
          dir: m.direction,
          text: m.message,
          ts: m.timestamp.toISOString(),
        })),
      ]
        .slice(-20)
        .map((m) => `[${m.dir.toUpperCase()} ${m.ts.slice(0, 16)}] ${m.text}`)
        .join("\n");

      const lastMsg = msgs[msgs.length - 1];
      const chatName = lastMsg.chatName || lastMsg.fromName;

      // 7. Classify with Claude (system prompt is cached across iterations)
      let classification: Classification | null = null;
      try {
        const result = await cachedCall({
          model: "sonnet",
          systemPrompt: WHATSAPP_CLASSIFIER_SYSTEM,
          userMessage: `Chat: ${chatName}\nPhone: ${lastMsg.fromPhone}\nLast 20 messages:\n${context}`,
          maxTokens: 512,
        });
        classification = parseJsonResponse<Classification>(result.content);
      } catch (e) {
        errors.push(`classify ${chatId}: ${e}`);
        continue;
      }

      if (!classification) {
        errors.push(`invalid JSON for ${chatId}`);
        continue;
      }

      // 8. Handle NOISE → suggest bot rule
      if (classification.status === "NOISE") {
        const alreadyBot = botPhones.has(lastMsg.fromPhone);
        if (!alreadyBot) {
          await db.from("rules_memory").insert({
            user_id: userId,
            trigger: `WhatsApp sender = ${lastMsg.fromPhone}`,
            rule_type: "bot",
            category: "bot",
            reason: "Auto-detected: one-sided automated messages",
            is_active: false,
            created_by: "claude",
            suggestion_status: "pending",
            suggestion_confidence: 0.8,
          });
          rulesAdded++;
        }
        continue;
      }

      if (classification.status === "CLOSED") continue;

      // 9. Create task for NEEDS_RESPONSE / WAITING_REPLY / PERSONAL_REMINDER
      const emoji =
        classification.status === "NEEDS_RESPONSE"
          ? "🔴"
          : classification.status === "WAITING_REPLY"
            ? "🟠"
            : "💡";

      const now = new Date();
      let dueDate: string;
      if (classification.status === "NEEDS_RESPONSE") {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        dueDate = tomorrow.toISOString().slice(0, 10);
      } else {
        dueDate = now.toISOString().slice(0, 10);
      }

      const description = [
        `הקשר:\n${classification.context_summary}`,
        `\nההודעה האחרונה:\n"${classification.last_msg_summary}"`,
      ].join("\n");

      const { data: existing } = await db
        .from("tasks")
        .select("id")
        .eq("user_id", userId)
        .eq("source_message_id", `wa:${chatId}`)
        .neq("status", "archived")
        .neq("status", "completed")
        .maybeSingle();

      if (existing) {
        await db
          .from("tasks")
          .update({
            description,
            priority: classification.urgency,
            due_date: dueDate,
            ai_actions: classification.suggested_actions.map((a) => ({ label: a, prompt: a })),
          })
          .eq("id", existing.id);
      } else {
        await db.from("tasks").insert({
          user_id: userId,
          title: `${emoji} ${chatName} — ${classification.topic}`,
          title_he: `${emoji} ${chatName} — ${classification.topic}`,
          description,
          priority: classification.urgency,
          status: "inbox",
          task_type: "action",
          due_date: dueDate,
          source_message_id: `wa:${chatId}`,
          source_link: `https://wa.me/${lastMsg.fromPhone.replace(/\D/g, "")}`,
          related_contact: chatName,
          related_contact_phone: lastMsg.fromPhone,
          ai_actions: classification.suggested_actions.map((a) => ({ label: a, prompt: a })),
          ai_model_used: MODELS.sonnet,
          manually_verified: false,
        });
        tasksCreated++;
      }
    }

    // 10. Update checkpoint
    if (maxRowIndex > lastRow) {
      await updateSyncState(userId, "whatsapp", String(maxRowIndex));
    }

    await closeRunSession(
      sessionId,
      errors.length === 0 ? "completed" : "partial",
      {
        items_processed: itemsProcessed,
        tasks_created: tasksCreated,
        rules_added: rulesAdded,
        errors_count: errors.length,
      },
      `Processed ${threads.size} threads. Created ${tasksCreated} tasks.`,
      errors,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    await closeRunSession(
      sessionId,
      "failed",
      { errors_count: 1 },
      `Fatal: ${msg}`,
      errors,
    );
    throw err;
  }

  return { sessionId };
}
