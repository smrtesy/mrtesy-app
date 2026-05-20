/**
 * WhatsApp Edge Function v11 — port of server/src/modules/smrttask/routes/
 * whatsapp-webhook.ts (Express, 1015 lines) running on Supabase Edge.
 *
 * RUNS IN ONE OF TWO MODES, decided by the X-Shadow-Run request header:
 *
 * - X-Shadow-Run: 1   (shadow mode — current default)
 *     Express still owns the production webhook and writes whatsapp_messages
 *     + source_messages. Express then forwards the same payload to this
 *     function. We walk the payload to identify which (user_id, chat_id)
 *     pairs were touched, read the already-Express-written whatsapp_messages
 *     rows, and upsert a parallel row into source_messages_shadow. A SQL
 *     diff between source_messages and source_messages_shadow tells us
 *     whether the Edge grouping logic is byte-identical to Express.
 *
 *     HMAC verification is SKIPPED in shadow mode — Express already verified
 *     before forwarding, and trust comes from the internal Railway → Edge
 *     network path.
 *
 * - X-Shadow-Run absent / 0   (live mode — future state)
 *     Edge becomes the production webhook. DualHook points DIRECTLY here,
 *     Express webhook is retired. Live mode writes whatsapp_messages AND
 *     source_messages. NOT ACTIVE YET — Express webhook still owns this.
 *     Live mode is stubbed for now; flip the constant LIVE_MODE_ENABLED at
 *     the top of this file when ready for staging.
 *
 * The conversation-grouping algorithm in buildAndUpsertSourceMessage MUST
 * remain bit-identical to refreshSourceMessageThread() in whatsapp-webhook.ts
 * — that's the whole point of the shadow comparison.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LIVE_MODE_ENABLED = false; // Flip to true after shadow diff is clean.

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ─────────────────────────────────────────────────────────────────────────────
// Meta payload types — minimum shape we read (mirror of whatsapp-webhook.ts)
// ─────────────────────────────────────────────────────────────────────────────

interface MetaMessage {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  type?: string;
  chat_id?: string;
  group_id?: string;
  isGroup?: boolean;
}

interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

interface MetaMetadata {
  display_phone_number?: string;
  phone_number_id?: string;
}

interface MetaChange {
  field?: string;
  value?: {
    metadata?: MetaMetadata;
    contacts?: MetaContact[];
    messages?: MetaMessage[];
    message_echoes?: MetaMessage[];
    smb_message_echoes?: MetaMessage[];
    history?: Array<{
      threads?: Array<{ id?: string; messages?: MetaMessage[] }>;
    }>;
    statuses?: unknown[];
  };
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{ changes?: MetaChange[] }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const isShadow = req.headers.get("X-Shadow-Run") === "1";

  if (!isShadow && !LIVE_MODE_ENABLED) {
    // Safety net: refuse non-shadow traffic until live mode is explicitly
    // enabled. Otherwise a misconfigured DualHook could start writing
    // duplicate whatsapp_messages rows.
    return new Response(
      JSON.stringify({ error: "live mode disabled — set X-Shadow-Run: 1" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  let payload: MetaWebhookBody;
  try {
    payload = (await req.json()) as MetaWebhookBody;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), { status: 200 });
  }

  if (!payload || !Array.isArray(payload.entry)) {
    return new Response(JSON.stringify({ ok: false, error: "shape_invalid" }), { status: 200 });
  }

  try {
    const result = await processWebhookPayload(payload, isShadow);
    return new Response(JSON.stringify({ ok: true, shadow: isShadow, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[whatsapp-v11] processing error:", (e as Error).message);
    // Mirror Express: always 200 to Meta/Express so they don't retry forever.
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Payload walker — extract every (user_id, chat_id) touched by this payload
// ─────────────────────────────────────────────────────────────────────────────

interface TouchedChat {
  userId: string;
  chatId: string;
}

async function processWebhookPayload(
  payload: MetaWebhookBody,
  isShadow: boolean,
): Promise<{ touched: number; refreshed: number }> {
  const touched = new Set<string>(); // dedup key: `${userId}|${chatId}`
  const connectionByPhone = new Map<string, string | null>(); // phone_number_id → user_id

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      // Resolve once per phone_number_id per request.
      let userId = connectionByPhone.get(phoneNumberId);
      if (userId === undefined) {
        userId = await resolveUserId(phoneNumberId);
        connectionByPhone.set(phoneNumberId, userId);
      }
      if (!userId) continue;

      // Collect chat_ids from each event type. Mirrors normalizeLive /
      // normalizeHistory in whatsapp-webhook.ts.
      if (change.field === "messages" || change.field == null) {
        for (const m of value.messages ?? []) addChatId(touched, userId, deriveChatIdLive(m, "incoming", value.metadata));
        for (const m of value.message_echoes ?? []) addChatId(touched, userId, deriveChatIdLive(m, "outgoing", value.metadata));
        for (const m of value.smb_message_echoes ?? []) addChatId(touched, userId, deriveChatIdLive(m, "outgoing", value.metadata));
      } else if (change.field === "smb_message_echoes" || change.field === "message_echoes") {
        for (const m of value.message_echoes ?? []) addChatId(touched, userId, deriveChatIdLive(m, "outgoing", value.metadata));
        for (const m of value.smb_message_echoes ?? []) addChatId(touched, userId, deriveChatIdLive(m, "outgoing", value.metadata));
      } else if (change.field === "history") {
        for (const chunk of value.history ?? []) {
          for (const thread of chunk.threads ?? []) {
            const tid = String(thread.id ?? "");
            if (tid) addChatId(touched, userId, tid);
          }
        }
      }
      // statuses: ignored (delivery/read receipts)
    }
  }

  let refreshed = 0;
  for (const key of touched) {
    const [userId, chatId] = key.split("|");
    try {
      await buildAndUpsertSourceMessage(userId, chatId, isShadow);
      refreshed++;
    } catch (e) {
      console.warn(`[whatsapp-v11] refresh failed for ${key}:`, (e as Error).message);
    }
  }

  return { touched: touched.size, refreshed };
}

function addChatId(set: Set<string>, userId: string, chatId: string): void {
  if (chatId) set.add(`${userId}|${chatId}`);
}

function deriveChatIdLive(
  m: MetaMessage,
  direction: "incoming" | "outgoing",
  metadata?: MetaMetadata,
): string {
  const fromPhone = String(m.from ?? "");
  const toPhone = String(m.to ?? metadata?.display_phone_number ?? "");
  return String(m.chat_id ?? m.group_id ?? (direction === "outgoing" ? toPhone : fromPhone));
}

// ─────────────────────────────────────────────────────────────────────────────
// User resolution
// ─────────────────────────────────────────────────────────────────────────────

async function resolveUserId(phoneNumberId: string): Promise<string | null> {
  const { data } = await supabase
    .from("whatsapp_connections")
    .select("user_id")
    .eq("phone_number_id", phoneNumberId)
    .is("disconnected_at", null)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation grouping — bit-identical port of refreshSourceMessageThread()
// ─────────────────────────────────────────────────────────────────────────────

interface WhatsappMessageRow {
  direction: string | null;
  body_text: string | null;
  received_at: string | null;
  from_phone: string | null;
  from_name: string | null;
  is_history: boolean | null;
}

async function buildAndUpsertSourceMessage(
  userId: string,
  chatId: string,
  isShadow: boolean,
): Promise<void> {
  // Load the last 20 messages for this chat. Same select shape Express uses.
  const { data: msgs, error } = await supabase
    .from("whatsapp_messages")
    .select("direction, body_text, received_at, from_phone, from_name, is_history")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .order("received_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(`whatsapp_messages read: ${error.message}`);
  if (!msgs || msgs.length === 0) {
    // Express has not (yet) written whatsapp_messages for this chat. In
    // shadow mode this can happen if Edge runs faster than Express's await
    // chain; in live mode it means our walker found a chat that has no
    // recoverable messages. Either way, no-op.
    return;
  }

  // msgs is newest-first; flip to chronological.
  const ordered = [...(msgs as WhatsappMessageRow[])].reverse();
  const last = ordered[ordered.length - 1];

  const latestIncoming = [...ordered].reverse().find((m) => m.direction === "incoming");
  const chatName =
    (latestIncoming?.from_name as string | null) ||
    (last.from_name as string | null) ||
    (last.from_phone as string | null) ||
    chatId;
  const fromPhone =
    (latestIncoming?.from_phone as string | null) ||
    (last.from_phone as string | null) ||
    chatId;
  const isGroup = !/^\d+$/.test(chatId) || chatId.length > 15;

  const conversationLines = ordered
    .map((m) => {
      const ts = String(m.received_at ?? "").slice(0, 16);
      const dir = String(m.direction ?? "incoming").toUpperCase();
      const text = String(m.body_text ?? "").replace(/\s+/g, " ").trim();
      return `[${dir} ${ts}] ${text}`;
    })
    .join("\n");

  const rawContent = [
    `Chat: ${chatName}`,
    `Phone: ${fromPhone}`,
    `Group: ${isGroup}`,
    `\n--- CONVERSATION (last 20 messages) ---`,
    conversationLines,
  ].join("\n");

  const row = {
    user_id: userId,
    source_type: "whatsapp",
    source_id: `wa:${chatId}`,
    sender: chatName,
    sender_email: null as string | null,
    subject: chatName,
    body_text: String(last.body_text ?? "").slice(0, 1000),
    raw_content: rawContent.slice(0, 3000),
    received_at: last.received_at,
    source_url: `https://wa.me/${String(fromPhone).replace(/\D/g, "")}`,
    reply_to_context: fromPhone,
    processing_status: "pending",
    metadata: { chatId, chatName, fromPhone, isGroup },
  };

  const table = isShadow ? "source_messages_shadow" : "source_messages";
  const { error: upsertErr } = await supabase.from(table).upsert(row, {
    onConflict: "user_id,source_type,source_id",
  });

  if (upsertErr) throw new Error(`${table} upsert: ${upsertErr.message}`);
}
