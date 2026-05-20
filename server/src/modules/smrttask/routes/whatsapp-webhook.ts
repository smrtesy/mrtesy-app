/**
 * WhatsApp inbound webhook — receives Meta Cloud API events that DualHook
 * routes to us via Webhook Override.
 *
 * Replaces the previous part2-whatsapp Google Sheet ingestion path.
 *
 * Flow per POST:
 *   1. Validate X-Hub-Signature-256 if META_APP_SECRET is set.
 *   2. Walk entry[].changes[]:
 *        - field=messages  → value.messages[]      (incoming live)
 *                          + value.message_echoes[] / smb_message_echoes[]
 *                            (outgoing from the user's phone, via Coexistence)
 *        - field=history   → value.history[].threads[].messages[]
 *                            (one-shot during onboarding, multiple chunks)
 *        - field=statuses  → ignore (delivery/read receipts)
 *   3. For each message:
 *        - Resolve user_id via whatsapp_connections.phone_number_id.
 *        - Skip if sender phone is bot-flagged in rules_memory.
 *        - Map to body_text (text passthrough; audio→Gemini transcript;
 *          image→Gemini OCR; documents/video/sticker/location/contacts/
 *          reaction/interactive → placeholder/structured text — matches
 *          the existing Apps Script).
 *        - Upsert into whatsapp_messages keyed on (user_id, wamid).
 *   4. For every chat_id touched in this batch, refresh the corresponding
 *      source_messages thread row (one row per chat, last 20 messages as
 *      raw_content, processing_status='pending' so Part 3 reclassifies).
 *
 * Always returns 200 fast. Heavy work (Gemini transcription, media download)
 * runs after we've responded so we stay inside Meta's ~250ms budget.
 */

import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { db, createRunSession, closeRunSession, loadRules, getAppSecret } from "../../../db";
import { transcribeAudio, performImageOcr } from "../../../gemini";

const router = Router();

/** Meta API version — read from app_secrets (admin UI), env fallback. */
async function getMetaApiVersion(): Promise<string> {
  return (await getAppSecret("smrttask", "META_API_VERSION", "META_API_VERSION")) ?? "v21.0";
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — minimal shape of the Meta Cloud API webhook payload we read
// ─────────────────────────────────────────────────────────────────────────────

interface MetaMessage {
  id?: string;
  from?: string;
  to?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  audio?: { id?: string; mime_type?: string };
  voice?: { id?: string; mime_type?: string };
  image?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  sticker?: { id?: string; mime_type?: string };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  contacts?: Array<{
    name?: { formatted_name?: string };
    phones?: Array<{ phone?: string }>;
  }>;
  reaction?: { message_id?: string; emoji?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
  context?: { id?: string };
  // Coexistence / history threading hints
  chat_id?: string;
  group_id?: string;
  group_name?: string;
  chat_name?: string;
  isGroup?: boolean;
  history_context?: { status?: string };
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
    messaging_product?: string;
    metadata?: MetaMetadata;
    contacts?: MetaContact[];
    messages?: MetaMessage[];
    message_echoes?: MetaMessage[];
    smb_message_echoes?: MetaMessage[];
    history?: Array<{
      metadata?: { phase?: number; chunk_order?: number; progress?: number };
      threads?: Array<{
        id?: string;
        thread_name?: string;
        messages?: MetaMessage[];
      }>;
    }>;
    statuses?: unknown[];
  };
}

interface MetaWebhookBody {
  object?: string;
  entry?: Array<{ id?: string; changes?: MetaChange[] }>;
}

interface NormalizedMessage {
  meta: MetaMessage;
  contacts: MetaContact[];
  metadata: MetaMetadata;
  direction: "incoming" | "outgoing";
  isHistory: boolean;
  historyPhase: number | null;
  chatId: string;
  fromPhone: string;
  fromName: string;
  toPhone: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET — Meta verify handshake
// ─────────────────────────────────────────────────────────────────────────────

router.get("/webhooks/whatsapp", async (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode !== "subscribe" || typeof token !== "string") {
    console.warn(`[whatsapp-webhook] verify failed (mode=${String(mode)})`);
    return res.status(403).type("text/plain").send("forbidden");
  }

  // Match the verify token against every connection's vaulted token.
  // For single-tenant this is trivially "the only one"; for multi-tenant
  // it accepts any active connection's token. (URL-scoping comes later.)
  // Env fallback during transition: if a connection has no vaulted token
  // yet, we still allow the legacy WHATSAPP_WEBHOOK_VERIFY_TOKEN.
  const envToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (envToken && token === envToken) {
    return res.status(200).type("text/plain").send(challenge ?? "");
  }

  const { data: rows } = await db
    .from("whatsapp_connections")
    .select("verify_token_id")
    .is("disconnected_at", null);

  for (const row of rows ?? []) {
    const id = (row.verify_token_id as string | null) ?? null;
    if (!id) continue;
    const { data: plaintext } = await db.rpc("vault_read_secret", { secret_id: id });
    if (typeof plaintext === "string" && plaintext === token) {
      return res.status(200).type("text/plain").send(challenge ?? "");
    }
  }

  console.warn("[whatsapp-webhook] verify token did not match any connection");
  return res.status(403).type("text/plain").send("forbidden");
});

// ─────────────────────────────────────────────────────────────────────────────
// POST — main webhook receiver
// ─────────────────────────────────────────────────────────────────────────────

// Express extension carrying the unparsed body. We need it for HMAC
// verification: re-stringifying req.body would change whitespace/ordering
// and break Meta's signature. server/src/index.ts is responsible for
// stashing the raw bytes via express.json's `verify` callback.
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

router.post("/webhooks/whatsapp", async (req: Request, res: Response) => {
  const rawBuf = (req as RawBodyRequest).rawBody;
  const rawBody = rawBuf ? rawBuf.toString("utf8") : JSON.stringify(req.body ?? {});

  // Parse JSON FIRST (without trusting it), so we can find the phone_number_id
  // → connection → app_secret needed to validate the HMAC. The shape guard
  // below makes sure malformed or non-Meta payloads short-circuit to 200.
  let payload: MetaWebhookBody;
  try {
    const raw =
      typeof req.body === "object" && req.body !== null
        ? (req.body as MetaWebhookBody)
        : (JSON.parse(rawBody) as MetaWebhookBody);
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entry)) {
      // Still record what we got — helps diagnose calls that look misrouted.
      void recordDebug(raw, [], "shape_invalid");
      return res.status(200).json({ ok: false, error: "shape_invalid" });
    }
    payload = raw;
  } catch {
    return res.status(200).json({ ok: false, error: "invalid_json" });
  }

  // DEBUG: record every legitimate POST so we can inspect outgoing-message
  // (echo) events that aren't yet appearing in whatsapp_messages.
  const fields: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field) fields.push(change.field);
    }
  }
  void recordDebug(payload, fields, null);

  // Pick the first phone_number_id we can find. Meta sends one signature
  // per request, so all entries must come from the same app secret — a
  // multi-WABA payload from Meta is implausible. (We still walk every entry
  // when *processing*, just not when picking the secret.)
  const firstPhoneNumberId = findFirstPhoneNumberId(payload);

  // Resolve the App Secret for this WABA. Env fallback covers the brief
  // window between deploying this code and the user pasting their secret
  // into onboarding — both can run in parallel.
  let appSecret: string | null = process.env.META_APP_SECRET ?? null;
  if (firstPhoneNumberId) {
    const fromVault = await resolveAppSecret(firstPhoneNumberId);
    if (fromVault) appSecret = fromVault;
  }

  if (appSecret) {
    const header = req.headers["x-hub-signature-256"];
    const sig = typeof header === "string" ? header : "";
    const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    if (!sig || !timingSafeEqual(sig, expected)) {
      console.warn("[whatsapp-webhook] signature mismatch — rejecting");
      // Return 200 anyway so Meta doesn't retry forever on a misconfig.
      return res.status(200).json({ ok: false, error: "signature_mismatch" });
    }
  }

  // Process synchronously: the heavy work here is Gemini calls for live
  // audio/image messages (typically 0-2 per webhook event, ~3s each).
  // History chunks can carry hundreds of messages but they skip Gemini by
  // design (no transcription/OCR for old media — matches the Apps Script).
  // Awaiting also prevents a history batch from spawning hundreds of
  // parallel Gemini calls and saturating quota.
  //
  // We still return 200 even when processing throws — Meta retries on
  // non-200 with exponential backoff for days, which would amplify any
  // transient failure into a storm.
  try {
    await processWebhookPayload(payload);
  } catch (err) {
    console.error("[whatsapp-webhook] processing error:", err);
  }

  // Shadow run: after Express has finished writing whatsapp_messages and
  // source_messages, forward the same payload to the whatsapp-v11 Edge
  // Function so it can build a parallel row in source_messages_shadow. We
  // can then SQL-diff source_messages vs source_messages_shadow to verify
  // the Edge port is byte-identical to Express before flipping production.
  //
  // Fire-and-forget — never blocks the 200 response back to Meta, and any
  // error here is logged but does NOT affect the user-visible webhook.
  // Controlled by env so we can disable instantly if it misbehaves.
  if (process.env.WHATSAPP_SHADOW_FORWARD === "1") {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (supabaseUrl) {
      fetch(`${supabaseUrl}/functions/v1/whatsapp-v11`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shadow-Run": "1" },
        body: rawBody,
      }).catch((e) => {
        console.warn("[whatsapp-webhook] shadow forward failed:", e instanceof Error ? e.message : e);
      });
    }
  }

  return res.status(200).json({ ok: true });
});

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Look through a Meta webhook body and return the first
 * `entry[i].changes[j].value.metadata.phone_number_id` we find. We use it
 * to identify which WABA the payload is for before HMAC validation.
 */
function findFirstPhoneNumberId(payload: MetaWebhookBody): string | null {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const id = change.value?.metadata?.phone_number_id;
      if (id) return id;
    }
  }
  return null;
}

/**
 * Append every incoming Meta payload to whatsapp_webhook_debug. Temporary —
 * we're using this to diagnose missing outgoing-message echoes. The insert
 * is fire-and-forget so it can't slow the webhook response.
 */
async function recordDebug(
  payload: unknown,
  fields: string[],
  notes: string | null,
): Promise<void> {
  try {
    await db.from("whatsapp_webhook_debug").insert({
      payload: payload as Record<string, unknown>,
      fields,
      notes,
    });
  } catch (e) {
    console.error("[whatsapp-webhook] debug insert failed:", e instanceof Error ? e.message : e);
  }
}

/** Resolve the per-WABA Meta App Secret from Vault, or null if not set. */
async function resolveAppSecret(phoneNumberId: string): Promise<string | null> {
  const { data } = await db
    .from("whatsapp_connections")
    .select("app_secret_id")
    .eq("phone_number_id", phoneNumberId)
    .is("disconnected_at", null)
    .maybeSingle();
  const id = (data?.app_secret_id as string | null | undefined) ?? null;
  if (!id) return null;
  const { data: plaintext, error } = await db.rpc("vault_read_secret", { secret_id: id });
  if (error) {
    console.error(`[whatsapp-webhook] vault_read_secret(${id}) failed:`, error.message);
    return null;
  }
  return typeof plaintext === "string" ? plaintext : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload walker
// ─────────────────────────────────────────────────────────────────────────────

async function processWebhookPayload(payload: MetaWebhookBody): Promise<void> {
  if (!payload.entry || payload.entry.length === 0) return;

  // Group normalized messages by user_id so we can debounce the thread
  // refresh per (user_id, chat_id) instead of one refresh per message —
  // history chunks can carry hundreds of messages across many chats.
  const perUser = new Map<string, NormalizedMessage[]>();
  // Resolved access tokens, also keyed by user_id, so we Vault-read once
  // per batch even if the payload spans multiple changes for the same user.
  const tokenByUser = new Map<string, string | null>();
  // Cache phone_number_id → resolved connection within the request so we
  // never run resolveConnection twice for the same Meta number.
  const connectionByPhone = new Map<string, ResolvedConnection | null>();

  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;

      const metadata = value.metadata ?? {};
      const phoneNumberId = metadata.phone_number_id;
      if (!phoneNumberId) {
        console.warn("[whatsapp-webhook] event with no phone_number_id, skipping");
        continue;
      }

      // Look up the smrtTask user and access token for this Meta phone number.
      let conn = connectionByPhone.get(phoneNumberId);
      if (conn === undefined) {
        conn = await resolveConnection(phoneNumberId);
        connectionByPhone.set(phoneNumberId, conn);
      }
      if (!conn) {
        console.warn(`[whatsapp-webhook] no connection for phone_number_id=${phoneNumberId}, skipping`);
        continue;
      }
      const userId = conn.userId;
      tokenByUser.set(userId, conn.accessToken);

      const contacts = value.contacts ?? [];
      const list = perUser.get(userId) ?? [];

      if (change.field === "messages" || change.field == null) {
        for (const m of value.messages ?? []) {
          list.push(normalizeLive(m, contacts, metadata, "incoming"));
        }
        // Some Coexistence flows tuck echoes into the messages event too.
        for (const m of value.message_echoes ?? []) {
          list.push(normalizeLive(m, contacts, metadata, "outgoing"));
        }
        for (const m of value.smb_message_echoes ?? []) {
          list.push(normalizeLive(m, contacts, metadata, "outgoing"));
        }
      } else if (
        change.field === "smb_message_echoes" ||
        change.field === "message_echoes"
      ) {
        // Standalone echo event for messages the user sent from their phone.
        // The outer field NAMES the event ("smb_message_echoes"), and the
        // payload always carries the array as value.message_echoes — the
        // "smb_" prefix is on the field, not the array key. The DualHook
        // debug logs from prod confirmed this shape.
        for (const m of value.message_echoes ?? []) {
          list.push(normalizeLive(m, contacts, metadata, "outgoing"));
        }
        // Defensive: handle either array name in case a different BSP
        // configuration mirrors the field name into the array.
        for (const m of value.smb_message_echoes ?? []) {
          list.push(normalizeLive(m, contacts, metadata, "outgoing"));
        }
      } else if (change.field === "history") {
        for (const chunk of value.history ?? []) {
          const phase = typeof chunk.metadata?.phase === "number" ? chunk.metadata.phase : null;
          for (const thread of chunk.threads ?? []) {
            const userPhone = String(thread.id ?? "");
            for (const m of thread.messages ?? []) {
              list.push(normalizeHistory(m, userPhone, metadata, phase));
            }
          }
        }
      } else if (change.field === "statuses") {
        // delivery/read receipts — intentionally ignored
        continue;
      } else {
        console.log(`[whatsapp-webhook] ignored field=${change.field}`);
      }

      perUser.set(userId, list);
    }
  }

  // Process each user's batch in its own run session for auditability.
  for (const [userId, messages] of perUser.entries()) {
    if (messages.length === 0) continue;
    const accessToken = tokenByUser.get(userId) ?? null;
    await processUserBatch(userId, messages, accessToken);
  }
}

interface ResolvedConnection {
  userId: string;
  /** Decrypted Meta Cloud API Bearer token, or null if the user hasn't
   *  pasted one yet — in which case we still log incoming messages, but
   *  can't fetch media (audio transcripts, images, documents). */
  accessToken: string | null;
}

async function resolveConnection(phoneNumberId: string): Promise<ResolvedConnection | null> {
  const { data } = await db
    .from("whatsapp_connections")
    .select("user_id, access_token_secret_id")
    .eq("phone_number_id", phoneNumberId)
    .is("disconnected_at", null)
    .maybeSingle();

  const userId = (data?.user_id as string | undefined) ?? null;
  if (!userId) return null;

  const secretId = (data?.access_token_secret_id as string | null | undefined) ?? null;
  let accessToken: string | null = null;
  if (secretId) {
    const { data: plaintext, error } = await db.rpc("vault_read_secret", {
      secret_id: secretId,
    });
    if (error) {
      console.error(`[whatsapp-webhook] vault_read_secret(${secretId}) failed:`, error.message);
    } else {
      accessToken = (plaintext as string | null) ?? null;
    }
  }

  return { userId, accessToken };
}

function normalizeLive(
  m: MetaMessage,
  contacts: MetaContact[],
  metadata: MetaMetadata,
  direction: "incoming" | "outgoing",
): NormalizedMessage {
  const fromPhone = String(m.from ?? "");
  const toPhone = String(m.to ?? metadata.display_phone_number ?? "");
  const isGroup = Boolean(m.group_id || m.isGroup || m.group_name);
  const chatId = String(m.chat_id ?? m.group_id ?? (direction === "outgoing" ? toPhone : fromPhone));

  const fromName =
    direction === "outgoing"
      ? "אני (מהטלפון)"
      : contacts.find((c) => c.wa_id === fromPhone)?.profile?.name ??
        contacts[0]?.profile?.name ??
        "";

  // suppress "unused var" — isGroup currently inferred elsewhere; kept for
  // future use if Meta starts populating chat_id on group events.
  void isGroup;

  return {
    meta: m,
    contacts,
    metadata,
    direction,
    isHistory: false,
    historyPhase: null,
    chatId,
    fromPhone,
    fromName,
    toPhone,
  };
}

function normalizeHistory(
  m: MetaMessage,
  threadId: string,
  metadata: MetaMetadata,
  historyPhase: number | null,
): NormalizedMessage {
  const myDisplay = String(metadata.display_phone_number ?? "");
  const myId = String(metadata.phone_number_id ?? "");
  const msgFrom = String(m.from ?? "");

  // Direction rules per the Apps Script: presence of `to` ⇒ outgoing;
  // else compare `from` to thread (= user side) vs our own phone.
  let direction: "incoming" | "outgoing" = "incoming";
  if (m.to) direction = "outgoing";
  else if (msgFrom === threadId) direction = "incoming";
  else if (msgFrom === myDisplay || msgFrom === myId) direction = "outgoing";

  const fromPhone = direction === "incoming" ? threadId : myDisplay || myId;
  const toPhone = direction === "outgoing" ? threadId : "";

  return {
    meta: m,
    contacts: [],
    metadata,
    direction,
    isHistory: true,
    historyPhase,
    chatId: threadId,
    fromPhone,
    fromName: direction === "outgoing" ? "אני (היסטוריה)" : "",
    toPhone,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-user batch
// ─────────────────────────────────────────────────────────────────────────────

async function processUserBatch(
  userId: string,
  messages: NormalizedMessage[],
  accessToken: string | null,
): Promise<void> {
  const isHistoryBatch = messages.some((m) => m.isHistory);
  const sessionId = await createRunSession(userId, "part2", "whatsapp").catch(() => null);

  // Bot filter — same trigger format part2 used.
  const rules = await loadRules(userId).catch(() => []);
  const botPhones = new Set(
    rules
      .filter((r) => r.rule_type === "bot" && r.category === "bot")
      .map((r) => String(r.trigger).replace(/^WhatsApp sender = /, "").trim()),
  );

  const touchedChats = new Set<string>();
  let inserted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const nm of messages) {
    if (!nm.meta.id) {
      skipped++;
      continue;
    }
    if (botPhones.has(nm.fromPhone)) {
      skipped++;
      continue;
    }

    try {
      const built = await buildMessageRow(userId, nm, accessToken);
      const { error } = await db
        .from("whatsapp_messages")
        .upsert(built, { onConflict: "user_id,wamid" });
      if (error) throw new Error(error.message);
      inserted++;
      touchedChats.add(nm.chatId);
    } catch (e) {
      errors.push(`${nm.meta.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Refresh each touched chat's source_messages row (one upsert per chat,
  // not per message — keeps history-chunk processing tractable).
  for (const chatId of touchedChats) {
    try {
      await refreshSourceMessageThread(userId, chatId);
    } catch (e) {
      errors.push(`refresh thread ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (sessionId) {
    await closeRunSession(
      sessionId,
      errors.length === 0 ? "completed" : "partial",
      {
        items_processed: inserted,
        items_skipped: skipped,
        errors_count: errors.length,
      },
      isHistoryBatch
        ? `WhatsApp history batch: ${inserted} messages across ${touchedChats.size} threads.`
        : `WhatsApp webhook batch: ${inserted} messages across ${touchedChats.size} threads.`,
      errors,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-message → whatsapp_messages row
// ─────────────────────────────────────────────────────────────────────────────

interface WhatsappMessageRow {
  user_id: string;
  wamid: string;
  chat_id: string;
  direction: "incoming" | "outgoing";
  from_phone: string;
  from_name: string | null;
  to_phone: string | null;
  message_type: string;
  body_text: string | null;
  media_id: string | null;
  media_mime: string | null;
  media_url: string | null;
  media_filename: string | null;
  media_size: number | null;
  reply_to_wamid: string | null;
  reaction_emoji: string | null;
  is_reaction: boolean;
  is_history: boolean;
  history_phase: number | null;
  received_at: string;
  raw_payload: MetaMessage;
}

async function buildMessageRow(
  userId: string,
  nm: NormalizedMessage,
  accessToken: string | null,
): Promise<WhatsappMessageRow> {
  const m = nm.meta;
  const type = (m.type ?? "unknown").toLowerCase();
  const ts = m.timestamp ? new Date(parseInt(m.timestamp, 10) * 1000) : new Date();

  let body = "";
  let mediaId: string | null = null;
  let mediaMime: string | null = null;
  let mediaUrl: string | null = null;
  let mediaFilename: string | null = null;
  let mediaSize: number | null = null;
  let replyTo = m.context?.id ?? null;
  let reactionEmoji: string | null = null;
  let isReaction = false;

  switch (type) {
    case "text":
      body = m.text?.body ?? "";
      break;

    case "audio":
    case "voice": {
      const a = m.audio ?? m.voice ?? {};
      mediaId = a.id ?? null;
      mediaMime = a.mime_type ?? null;
      if (nm.isHistory) {
        body = mediaId ? "[אודיו מהיסטוריה - לא תומלל]" : "[אודיו ישן - לא ניתן להורדה]";
      } else if (mediaId && accessToken) {
        try {
          const blob = await downloadMetaMedia(mediaId, accessToken);
          const transcript = await transcribeAudio(blob.base64, blob.mimeType);
          body = "[תמלול אודיו]\n" + transcript;
        } catch (e) {
          // Don't pollute the conversation with the raw Gemini error.
          // Log it and fall back to a clean placeholder.
          console.warn("[whatsapp-webhook] audio transcription failed:", e);
          body = "[אודיו - לא ניתן לתמלל כרגע]";
        }
      } else {
        body = "[אודיו - אין מפתחות לתמלול]";
      }
      break;
    }

    case "image": {
      const img = m.image ?? {};
      mediaId = img.id ?? null;
      mediaMime = img.mime_type ?? "image/jpeg";
      const caption = img.caption ?? "";
      if (nm.isHistory) {
        body = caption || "[תמונה מהיסטוריה - לא בוצע OCR]";
      } else if (mediaId && accessToken) {
        // 1) Fetch the bytes once and store them in Supabase Storage so
        //    the frontend can render the image directly (not just the OCR).
        //    OCR failure shouldn't lose the picture.
        // 2) Try OCR for body_text. If Gemini is rate-limited or fails,
        //    keep the caption (or a generic placeholder) — we don't want
        //    the raw error in the conversation log.
        let blob: MetaMediaBlob | null = null;
        try {
          blob = await downloadMetaMedia(mediaId, accessToken);
        } catch (e) {
          console.error("[whatsapp-webhook] image download failed:", e);
        }

        if (blob) {
          try {
            const stored = await persistMediaBlobToStorage(
              userId,
              m.id!,
              blob,
              filenameForImage(m.id!, blob.mimeType),
            );
            mediaUrl = stored.path;
            mediaFilename = stored.filename;
            mediaSize = stored.size;
          } catch (e) {
            console.error("[whatsapp-webhook] image storage upload failed:", e);
          }

          try {
            const ocr = await performImageOcr(blob.base64, blob.mimeType);
            body = (caption ? "כיתוב: " + caption + "\n\n" : "") + "[OCR]\n" + ocr;
          } catch (e) {
            console.warn("[whatsapp-webhook] image OCR failed, using caption only:", e);
            body = caption || "[תמונה]";
          }
        } else {
          body = caption || "[תמונה - שגיאת הורדה]";
        }
      } else {
        body = caption || "[תמונה - אין מפתחות ל-OCR]";
      }
      break;
    }

    case "document": {
      const d = m.document ?? {};
      mediaId = d.id ?? null;
      mediaMime = d.mime_type ?? null;
      const filename = d.filename ?? (mediaId ? `document_${mediaId}` : "document");
      const caption = d.caption ?? "";
      if (nm.isHistory && !mediaId) {
        body = caption || "[מסמך ישן - לא ניתן להורדה]";
      } else if (nm.isHistory) {
        body = caption || `[מסמך מהיסטוריה: ${filename}]`;
      } else if (mediaId && accessToken) {
        try {
          const stored = await persistDocumentToStorage(userId, m.id!, mediaId, filename, mediaMime, accessToken);
          mediaUrl = stored.path;
          mediaFilename = stored.filename;
          mediaSize = stored.size;
          body = caption || `[מסמך: ${filename}]`;
        } catch (e) {
          body =
            caption ||
            `[מסמך: ${filename}] [שגיאת שמירה: ${e instanceof Error ? e.message : String(e)}]`;
        }
      } else {
        body = caption || `[מסמך: ${filename}]`;
      }
      break;
    }

    case "video": {
      const v = m.video ?? {};
      mediaId = v.id ?? null;
      mediaMime = v.mime_type ?? null;
      body = v.caption ?? "[וידאו]";
      break;
    }

    case "sticker":
      mediaId = m.sticker?.id ?? null;
      mediaMime = m.sticker?.mime_type ?? null;
      body = "[מדבקה]";
      break;

    case "location": {
      const loc = m.location ?? {};
      body =
        `[מיקום] ${loc.latitude ?? "?"}, ${loc.longitude ?? "?"}` +
        (loc.name ? ` - ${loc.name}` : "") +
        (loc.address ? ` (${loc.address})` : "");
      break;
    }

    case "contacts": {
      const c = m.contacts?.[0] ?? {};
      const cName = c.name?.formatted_name ?? "";
      const cPhone = c.phones?.[0]?.phone ?? "";
      body = `[איש קשר] ${cName} - ${cPhone}`;
      break;
    }

    case "reaction": {
      reactionEmoji = m.reaction?.emoji ?? "";
      body = reactionEmoji;
      isReaction = true;
      // Reactions target a specific message — store its wamid in reply_to so
      // the UI can render the reaction under the original.
      if (m.reaction?.message_id) replyTo = m.reaction.message_id;
      break;
    }

    case "interactive": {
      const inter = m.interactive ?? {};
      if (inter.button_reply) body = `[כפתור] ${inter.button_reply.title ?? ""}`;
      else if (inter.list_reply) body = `[רשימה] ${inter.list_reply.title ?? ""}`;
      else body = "[הודעה אינטראקטיבית]";
      break;
    }

    default:
      body = `[סוג לא מזוהה: ${type}]`;
  }

  void userId; // surface intent — kept for symmetry with the row's user_id field

  return {
    user_id: userId,
    wamid: m.id!,
    chat_id: nm.chatId,
    direction: nm.direction,
    from_phone: nm.fromPhone,
    from_name: nm.fromName || null,
    to_phone: nm.toPhone || null,
    message_type: type,
    body_text: body,
    media_id: mediaId,
    media_mime: mediaMime,
    media_url: mediaUrl,
    media_filename: mediaFilename,
    media_size: mediaSize,
    reply_to_wamid: replyTo,
    reaction_emoji: reactionEmoji,
    is_reaction: isReaction,
    is_history: nm.isHistory,
    history_phase: nm.historyPhase,
    received_at: ts.toISOString(),
    raw_payload: m,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Document persistence — fetch from Meta, push to Supabase Storage
// ─────────────────────────────────────────────────────────────────────────────

interface PersistedDoc {
  /** Storage path inside the `whatsapp-media` bucket. */
  path: string;
  filename: string;
  size: number;
}

async function persistDocumentToStorage(
  userId: string,
  wamid: string,
  mediaId: string,
  filename: string,
  declaredMime: string | null,
  token: string,
): Promise<PersistedDoc> {
  const blob = await downloadMetaMedia(mediaId, token);
  return persistMediaBlobToStorage(userId, wamid, blob, filename, declaredMime);
}

/**
 * Upload an already-downloaded blob to the `whatsapp-media` bucket. Used
 * for images (where we already have the bytes in memory after the OCR
 * call) and as the inner step of persistDocumentToStorage.
 */
async function persistMediaBlobToStorage(
  userId: string,
  wamid: string,
  blob: MetaMediaBlob,
  filename: string,
  declaredMime: string | null = null,
): Promise<PersistedDoc> {
  const buf = Buffer.from(blob.base64, "base64");

  // Path convention: <user_id>/<wamid>-<filename>. Both segments are safe
  // inputs (uuid + wamid + sanitized filename); the filename can still
  // carry odd characters from WhatsApp so strip path separators.
  const safeName = filename.replace(/[/\\]+/g, "_").slice(0, 200);
  const path = `${userId}/${wamid}-${safeName}`;

  const { error: uploadErr } = await db.storage.from("whatsapp-media").upload(path, buf, {
    contentType: blob.mimeType || declaredMime || "application/octet-stream",
    upsert: true,
  });
  if (uploadErr) throw new Error(`storage upload: ${uploadErr.message}`);

  return { path, filename: safeName, size: buf.length };
}

/**
 * Build a safe filename for an image, since Meta doesn't supply one.
 * We use the wamid (already unique per message) plus an extension derived
 * from the mime type. Falls back to `.bin` if the mime is unknown.
 */
function filenameForImage(wamid: string, mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg":  "jpg",
    "image/png":  "png",
    "image/webp": "webp",
    "image/gif":  "gif",
  };
  const ext = map[mime.toLowerCase().split(";")[0].trim()] ?? "bin";
  // The wamid already contains its own segments — collapse non-alnum to keep
  // the filename portable.
  const safeBase = wamid.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  return `${safeBase}.${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Meta media fetch (two-step: ID → signed URL → bytes)
// ─────────────────────────────────────────────────────────────────────────────

interface MetaMediaBlob {
  base64: string;
  mimeType: string;
}

async function downloadMetaMedia(mediaId: string, token: string): Promise<MetaMediaBlob> {
  const apiVersion = await getMetaApiVersion();
  const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(
      `Meta media metadata ${metaRes.status}: ${(await metaRes.text().catch(() => "")).slice(0, 300)}`,
    );
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new Error("Meta media response missing url");

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`Meta media download ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());

  return { base64: buf.toString("base64"), mimeType: meta.mime_type ?? "application/octet-stream" };
}

// ─────────────────────────────────────────────────────────────────────────────
// source_messages thread refresh (one row per chat — same shape Part 2 used)
// ─────────────────────────────────────────────────────────────────────────────

async function refreshSourceMessageThread(userId: string, chatId: string): Promise<void> {
  // Load the last 20 messages for this chat in chronological order.
  const { data: msgs, error } = await db
    .from("whatsapp_messages")
    .select("direction, body_text, received_at, from_phone, from_name, is_history")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .order("received_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);
  if (!msgs || msgs.length === 0) return;

  // msgs is newest-first; flip to chronological for the conversation log.
  const ordered = [...msgs].reverse();
  const last = ordered[ordered.length - 1];

  // Figure out the chat metadata. fromName on the LATEST incoming message
  // is the best display name we have; fall back to phone otherwise.
  const latestIncoming = [...ordered].reverse().find((m) => m.direction === "incoming");
  const chatName = (latestIncoming?.from_name as string | null) || (last.from_name as string | null) || (last.from_phone as string | null) || chatId;
  const fromPhone = (latestIncoming?.from_phone as string | null) || (last.from_phone as string | null) || chatId;
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

  const { error: upsertErr } = await db.from("source_messages").upsert(
    {
      user_id: userId,
      source_type: "whatsapp",
      source_id: `wa:${chatId}`,
      sender: chatName,
      sender_email: null,
      subject: chatName,
      body_text: String(last.body_text ?? "").slice(0, 1000),
      raw_content: rawContent.slice(0, 3000),
      received_at: last.received_at,
      source_url: `https://wa.me/${String(fromPhone).replace(/\D/g, "")}`,
      reply_to_context: fromPhone,
      processing_status: "pending",
      metadata: {
        chatId,
        chatName,
        fromPhone,
        isGroup,
      },
    },
    { onConflict: "user_id,source_type,source_id" },
  );

  if (upsertErr) throw new Error(upsertErr.message);
}

export default router;
