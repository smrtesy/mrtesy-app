/**
 * PART 2 — WhatsApp Collector
 *
 * Reads messages from a Google Sheet (written by Dualhook), groups them into
 * conversation threads, and writes ONE source_message per chat to Supabase
 * with processing_status='pending' for PART 3 to classify.
 *
 * Part 2 intentionally does NOT call Claude and does NOT create tasks.
 * All classification happens in Part 3 so every source gets the same
 * deep-classifier treatment (open-task dedup, project matching, full task fields).
 *
 * Bot filtering: phones already marked as bots in rules_memory are skipped
 * without an AI call, keeping this step fast and cheap.
 */

import { google } from "googleapis";
import { db, loadRules, createRunSession, closeRunSession, updateSyncState } from "../db";
import { getOAuthClient } from "../services/token-refresh";

const ENV_SHEET_ID = process.env.WHATSAPP_SHEET_ID;
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

export interface Part2Options {
  userId: string;
  /** How many hours back to look. Default: 48. First run: use 168 (7 days). */
  lookbackHours?: number;
  /** If true, re-process messages even if already checkpointed */
  force?: boolean;
}

export async function runPart2(opts: Part2Options): Promise<{ sessionId: string }> {
  const { userId, lookbackHours = 48, force = false } = opts;
  const sessionId = await createRunSession(userId, "part2", "whatsapp");

  const errors: string[] = [];
  let itemsProcessed = 0;

  try {
    // 1. Load bot rules — skip known-spam phones without any AI call
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

    // 3. Resolve per-user Sheet ID
    const { data: settingsRow } = await db
      .from("user_settings")
      .select("whatsapp_sheet_id")
      .eq("user_id", userId)
      .maybeSingle();
    const sheetId = (settingsRow?.whatsapp_sheet_id as string | null | undefined) || ENV_SHEET_ID;
    if (!sheetId) {
      await closeRunSession(sessionId, "completed", { items_skipped: 0 }, "No WhatsApp Sheet configured for this user.");
      return { sessionId };
    }

    // 4. Authenticate with Google Sheets
    const auth = await getOAuthClient(userId, "gmail_calendar");
    const sheets = google.sheets({ version: "v4", auth });

    // 5. Fetch new rows from the Sheet
    const sheetsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
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
      if (messageType === "reaction") continue;

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

    // 6. Group by chatId, keep last 20 messages
    const threads = new Map<string, SheetRow[]>();
    for (const row of newRows) {
      if (!threads.has(row.chatId)) threads.set(row.chatId, []);
      threads.get(row.chatId)!.push(row);
    }

    // 7. Load previous messages from source_messages for thread context
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

    const existingContext = new Map<string, { text: string; direction: string; ts: string }[]>();
    for (const msg of existingMsgs ?? []) {
      const chatId = (msg.source_id as string).replace(/^wa:/, "");
      if (!existingContext.has(chatId)) existingContext.set(chatId, []);
      existingContext.get(chatId)!.push({
        text: msg.body_text ?? "",
        direction: (msg.metadata as Record<string, string> | null)?.direction ?? "incoming",
        ts: msg.received_at ?? "",
      });
    }

    // 8. Store each thread as a single source_message for Part 3 to classify
    for (const [chatId, msgs] of threads.entries()) {
      itemsProcessed++;

      const lastMsg = msgs[msgs.length - 1];
      const chatName = lastMsg.chatName || lastMsg.fromName;
      const sourceId = `wa:${chatId}`;

      // Build the full conversation thread (last 20 messages) as raw_content.
      // Part 3's deep classifier receives this exactly as-is.
      const conversationLines = [
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

      const rawContent = [
        `Chat: ${chatName}`,
        `Phone: ${lastMsg.fromPhone}`,
        `Group: ${lastMsg.isGroup}`,
        `\n--- CONVERSATION (last 20 messages) ---`,
        conversationLines,
      ].join("\n");

      try {
        await db.from("source_messages").upsert(
          {
            user_id: userId,
            source_type: "whatsapp",
            source_id: sourceId,
            sender: chatName,
            sender_email: null,
            subject: chatName,
            body_text: lastMsg.message.slice(0, 1000),
            raw_content: rawContent.slice(0, 3000),
            received_at: lastMsg.timestamp.toISOString(),
            // source_url used by TaskCard to render the WhatsApp link icon
            source_url: `https://wa.me/${lastMsg.fromPhone.replace(/\D/g, "")}`,
            // reply_to_context stores the phone for Part 3 to set related_contact_phone on the task
            reply_to_context: lastMsg.fromPhone,
            processing_status: "pending",
            metadata: {
              chatId,
              chatName,
              fromPhone: lastMsg.fromPhone,
              isGroup: lastMsg.isGroup,
              lastRowIndex: lastMsg.rowIndex,
            },
          },
          { onConflict: "user_id,source_type,source_id" },
        );
      } catch (e) {
        errors.push(`upsert source_message for ${chatId}: ${e}`);
      }
    }

    // 9. Advance checkpoint
    if (maxRowIndex > lastRow) {
      await updateSyncState(userId, "whatsapp", String(maxRowIndex));
    }

    await closeRunSession(
      sessionId,
      errors.length === 0 ? "completed" : "partial",
      {
        items_processed: itemsProcessed,
        errors_count: errors.length,
      },
      `Collected ${threads.size} WhatsApp threads into source_messages (pending for Part 3).`,
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
