/**
 * WhatsApp inbound webhook — Vercel Route Handler.
 *
 * Moved from the Railway-hosted Express server to run on Vercel's edge of
 * Node.js Serverless Functions. Vercel's 99.99% uptime SLA on the Hobby
 * tier (same as Pro) makes a Railway dyno restart no longer drop incoming
 * messages.
 *
 * Behavior parity with server/src/modules/smrttask/routes/whatsapp-webhook.ts —
 * this is essentially the same code, retargeted at NextRequest/NextResponse
 * and using `createAdminSupabaseClient()` instead of the long-lived
 * service-role client from the Express server.
 *
 * Flow per POST:
 *   1. Read the raw body for HMAC verification.
 *   2. Parse JSON. Shape-guard against non-Meta payloads.
 *   3. Stash the payload in whatsapp_webhook_debug (diagnostic).
 *   4. Find the phone_number_id → resolve connection → decrypt App Secret.
 *      If a secret is configured, validate X-Hub-Signature-256.
 *   5. Walk entry[].changes[]:
 *        - "messages"          → incoming + Coexistence echoes
 *        - "smb_message_echoes" / "message_echoes" → outgoing echoes (phone-sent)
 *        - "history"           → one-shot Coexistence backfill
 *        - "statuses"          → ignored
 *   6. Per user batch:
 *        - skip bot-flagged senders;
 *        - map message → row (audio→Gemini transcript, image→Gemini OCR +
 *          Storage upload, document→Storage upload, etc.);
 *        - upsert into whatsapp_messages.
 *   7. Refresh source_messages thread row per touched chat so Part 3 sees
 *      the new context.
 *   8. Return 200 unconditionally — Meta otherwise retries for days.
 */

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

// We don't need the edge runtime; Node is fine here and lets us use
// `node:crypto`, `Buffer`, and the full Supabase client without polyfills.
export const runtime = "nodejs";
// Make sure Next never tries to cache or pre-render this route.
export const dynamic = "force-dynamic";

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

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
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
    statuses?: MetaStatus[];
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

interface ResolvedConnection {
  userId: string;
  /** Decrypted Meta Cloud API Bearer token, or null if not configured. */
  accessToken: string | null;
}

interface MetaMediaBlob {
  base64: string;
  mimeType: string;
}

interface PersistedDoc {
  path: string;
  filename: string;
  size: number;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// GET — Meta verify handshake
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode !== "subscribe" || !token) {
    console.warn(`[whatsapp-webhook] verify failed (mode=${String(mode)})`);
    return new Response("forbidden", { status: 403 });
  }

  // Env fallback during transition.
  const envToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (envToken && token === envToken) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  const db = createAdminSupabaseClient();
  if (!db) {
    console.error("[whatsapp-webhook] SUPABASE_SERVICE_ROLE_KEY missing");
    return new Response("server misconfigured", { status: 500 });
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
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
  }

  console.warn("[whatsapp-webhook] verify token did not match any connection");
  return new Response("forbidden", { status: 403 });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — main webhook receiver
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text();

  const db = createAdminSupabaseClient();
  if (!db) {
    console.error("[whatsapp-webhook] SUPABASE_SERVICE_ROLE_KEY missing");
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 200 });
  }

  let payload: MetaWebhookBody;
  try {
    const raw = JSON.parse(rawBody) as MetaWebhookBody;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entry)) {
      void recordDebug(db, raw, [], "shape_invalid");
      return NextResponse.json({ ok: false, error: "shape_invalid" }, { status: 200 });
    }
    payload = raw;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 200 });
  }

  // Debug log first so we can inspect even payloads that fail validation.
  const fields: string[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field) fields.push(change.field);
    }
  }
  void recordDebug(db, payload, fields, null);

  // App Secret: per-connection from Vault, or env fallback during rollout.
  const firstPhoneNumberId = findFirstPhoneNumberId(payload);
  let appSecret: string | null = process.env.META_APP_SECRET ?? null;
  if (firstPhoneNumberId) {
    const fromVault = await resolveAppSecret(db, firstPhoneNumberId);
    if (fromVault) appSecret = fromVault;
  }

  if (appSecret) {
    const sig = request.headers.get("x-hub-signature-256") ?? "";
    const expected =
      "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    if (!sig || !timingSafeEqual(sig, expected)) {
      console.warn("[whatsapp-webhook] signature mismatch — rejecting");
      return NextResponse.json({ ok: false, error: "signature_mismatch" }, { status: 200 });
    }
  }

  try {
    await processWebhookPayload(db, payload);
  } catch (err) {
    console.error("[whatsapp-webhook] processing error:", err);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type SupabaseAdmin = NonNullable<ReturnType<typeof createAdminSupabaseClient>>;

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function findFirstPhoneNumberId(payload: MetaWebhookBody): string | null {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const id = change.value?.metadata?.phone_number_id;
      if (id) return id;
    }
  }
  return null;
}

async function recordDebug(
  db: SupabaseAdmin,
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

async function resolveAppSecret(db: SupabaseAdmin, phoneNumberId: string): Promise<string | null> {
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

async function resolveConnection(
  db: SupabaseAdmin,
  phoneNumberId: string,
): Promise<ResolvedConnection | null> {
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
    const { data: plaintext, error } = await db.rpc("vault_read_secret", { secret_id: secretId });
    if (error) {
      console.error(`[whatsapp-webhook] vault_read_secret(${secretId}) failed:`, error.message);
    } else {
      accessToken = (plaintext as string | null) ?? null;
    }
  }

  return { userId, accessToken };
}

async function getMetaApiVersion(db: SupabaseAdmin): Promise<string> {
  return (await getAppSecret(db, "smrttask", "META_API_VERSION", "META_API_VERSION")) ?? "v21.0";
}

/**
 * Read a platform-wide app config value. Tries app_secrets first (Vault
 * for secrets, value_text for plain), falls back to the named env var.
 * No in-memory cache here because Vercel serverless functions cold-start
 * frequently and an in-process cache would be inconsistent — but each
 * invocation only reads ~4 values so the cost is negligible.
 */
async function getAppSecret(
  db: SupabaseAdmin,
  appSlug: string,
  key: string,
  envFallback?: string,
): Promise<string | null> {
  const { data: app } = await db.from("apps").select("id").eq("slug", appSlug).maybeSingle();
  if (app) {
    const { data: row } = await db
      .from("app_secrets")
      .select("is_secret, value_text, value_secret_id")
      .eq("app_id", app.id)
      .eq("key", key)
      .maybeSingle();
    if (row) {
      if (row.is_secret && row.value_secret_id) {
        const { data: plaintext } = await db.rpc("vault_read_secret", {
          secret_id: row.value_secret_id,
        });
        if (typeof plaintext === "string") return plaintext;
      } else if (!row.is_secret) {
        return (row.value_text as string | null) ?? null;
      }
    }
  }
  if (envFallback) return process.env[envFallback] ?? null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload walker
// ─────────────────────────────────────────────────────────────────────────────

async function processWebhookPayload(db: SupabaseAdmin, payload: MetaWebhookBody): Promise<void> {
  if (!payload.entry || payload.entry.length === 0) return;

  const perUser = new Map<string, NormalizedMessage[]>();
  const tokenByUser = new Map<string, string | null>();
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

      let conn = connectionByPhone.get(phoneNumberId);
      if (conn === undefined) {
        conn = await resolveConnection(db, phoneNumberId);
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
        for (const m of value.message_echoes ?? []) {
          list.push(normalizeLive(m, contacts, metadata, "outgoing"));
        }
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
        // Delivery/read receipts on outgoing messages. Process inline so
        // the UI's checkmarks update without waiting for an unrelated
        // event to wake the thread.
        for (const s of value.statuses ?? []) {
          await applyStatusUpdate(db, s);
        }
        continue;
      } else {
        console.log(`[whatsapp-webhook] ignored field=${change.field}`);
      }

      perUser.set(userId, list);
    }
  }

  for (const [userId, messages] of perUser.entries()) {
    if (messages.length === 0) continue;
    const accessToken = tokenByUser.get(userId) ?? null;
    await processUserBatch(db, userId, messages, accessToken);
  }
}

/**
 * Apply a Meta status event (sent/delivered/read/failed) to the matching
 * outgoing message. We only advance the status MONOTONICALLY — once a
 * message is `read`, a later `delivered` event (which Meta sometimes
 * sends out of order) won't downgrade it.
 */
const STATUS_RANK: Record<string, number> = {
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 4, // terminal; never downgraded
};

async function applyStatusUpdate(db: SupabaseAdmin, s: MetaStatus): Promise<void> {
  const wamid = s.id;
  const newStatus = s.status;
  if (!wamid || !newStatus || !(newStatus in STATUS_RANK)) return;

  const ts = s.timestamp ? new Date(parseInt(s.timestamp, 10) * 1000).toISOString() : null;

  // Look up the current status to decide whether this event is a real
  // forward-tick. We also need user_id for the .eq filter scope.
  const { data: existing } = await db
    .from("whatsapp_messages")
    .select("id, status, sent_at, delivered_at, read_at")
    .eq("wamid", wamid)
    .maybeSingle();
  if (!existing) {
    // Status arrived before the message echo did — rare but possible. We
    // could buffer it, but the simpler move is to ignore: Meta resends
    // the read receipt for unread messages occasionally, and the message
    // will get its first status when the next event arrives.
    return;
  }

  const currentRank = STATUS_RANK[(existing.status as string) ?? ""] ?? 0;
  const incomingRank = STATUS_RANK[newStatus] ?? 0;

  const update: Record<string, unknown> = {};
  // Always populate the per-stage timestamp if we have one and haven't yet.
  if (ts) {
    if (newStatus === "sent" && !existing.sent_at) update.sent_at = ts;
    if (newStatus === "delivered" && !existing.delivered_at) update.delivered_at = ts;
    if (newStatus === "read" && !existing.read_at) update.read_at = ts;
  }
  // Only advance `status` if this event is later in the lifecycle (or is
  // a `failed` event, which always wins as a terminal state).
  if (incomingRank > currentRank || newStatus === "failed") {
    update.status = newStatus;
    if (newStatus === "failed") {
      const errMsg = s.errors?.[0]?.message ?? s.errors?.[0]?.title ?? null;
      if (errMsg) update.status_error = errMsg;
    }
  }

  if (Object.keys(update).length === 0) return;

  const { error } = await db
    .from("whatsapp_messages")
    .update(update)
    .eq("wamid", wamid);
  if (error) console.warn("[whatsapp-webhook] status update failed:", error.message);
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
  db: SupabaseAdmin,
  userId: string,
  messages: NormalizedMessage[],
  accessToken: string | null,
): Promise<void> {
  const isHistoryBatch = messages.some((m) => m.isHistory);
  const sessionId = await createRunSession(db, userId, "part2", "whatsapp").catch(() => null);

  const rules = await loadRules(db, userId).catch(() => [] as RuleRow[]);
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
      const built = await buildMessageRow(db, userId, nm, accessToken);
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

  for (const chatId of touchedChats) {
    try {
      await refreshSourceMessageThread(db, userId, chatId);
    } catch (e) {
      errors.push(`refresh thread ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (sessionId) {
    await closeRunSession(
      db,
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

interface RuleRow {
  rule_type?: string | null;
  category?: string | null;
  trigger?: string | null;
}

async function loadRules(db: SupabaseAdmin, userId: string): Promise<RuleRow[]> {
  const { data, error } = await db
    .from("rules_memory")
    .select("rule_type, category, trigger")
    .eq("user_id", userId)
    .eq("is_active", true);
  if (error) {
    console.warn("[whatsapp-webhook] loadRules failed:", error.message);
    return [];
  }
  return (data as RuleRow[]) ?? [];
}

async function createRunSession(
  db: SupabaseAdmin,
  userId: string,
  part: string,
  runType: string,
): Promise<string | null> {
  const title = `${part.toUpperCase()} — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const { data, error } = await db
    .from("run_sessions")
    .insert({
      user_id: userId,
      run_title: title,
      run_type: runType,
      part,
      status: "running",
    })
    .select("id")
    .single();
  if (error) {
    console.warn("[whatsapp-webhook] createRunSession failed:", error.message);
    return null;
  }
  return data?.id as string | null;
}

async function closeRunSession(
  db: SupabaseAdmin,
  sessionId: string,
  status: "completed" | "partial" | "failed",
  counts: {
    items_processed?: number;
    items_skipped?: number;
    errors_count?: number;
  },
  summary: string,
  errorsLog: unknown[],
): Promise<void> {
  const { data: row } = await db
    .from("run_sessions")
    .select("started_at")
    .eq("id", sessionId)
    .maybeSingle();
  const startedAt = row?.started_at as string | undefined;
  const endedAt = new Date().toISOString();
  const durationSeconds = startedAt
    ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000)
    : null;

  await db
    .from("run_sessions")
    .update({
      status,
      ended_at: endedAt,
      duration_seconds: durationSeconds,
      summary,
      errors_log: errorsLog ?? [],
      ...counts,
    })
    .eq("id", sessionId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-message → whatsapp_messages row
// ─────────────────────────────────────────────────────────────────────────────

async function buildMessageRow(
  db: SupabaseAdmin,
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
          const blob = await downloadMetaMedia(db, mediaId, accessToken);
          // Persist the audio blob to storage alongside images. Without this
          // media_url stays NULL and the WhatsApp thread view can only show
          // the transcript — no inline playback. The user explicitly asked
          // for the recording itself.
          try {
            const ext = blob.mimeType.includes("ogg") ? "ogg"
              : blob.mimeType.includes("mp4") || blob.mimeType.includes("m4a") ? "m4a"
              : blob.mimeType.includes("wav") ? "wav"
              : "audio";
            const stored = await persistMediaBlobToStorage(
              db,
              userId,
              m.id!,
              blob,
              `audio_${m.id!}.${ext}`,
            );
            mediaUrl = stored.path;
            mediaFilename = stored.filename;
            mediaSize = stored.size;
          } catch (e) {
            console.error("[whatsapp-webhook] audio storage upload failed:", e);
          }

          const transcript = await transcribeAudio(db, blob.base64, blob.mimeType);
          body = transcript;
        } catch (e) {
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
        let blob: MetaMediaBlob | null = null;
        try {
          blob = await downloadMetaMedia(db, mediaId, accessToken);
        } catch (e) {
          console.error("[whatsapp-webhook] image download failed:", e);
        }

        if (blob) {
          try {
            const stored = await persistMediaBlobToStorage(
              db,
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
            const ocr = await performImageOcr(db, blob.base64, blob.mimeType);
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
          const stored = await persistDocumentToStorage(
            db,
            userId,
            m.id!,
            mediaId,
            filename,
            mediaMime,
            accessToken,
          );
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

    case "unsupported":
    case "revoke":
      // Meta sends `revoke` when the sender deletes a message in
      // WhatsApp (the "Delete for everyone" action). `unsupported` is
      // Meta's fallback for message types the API can't surface (e.g.,
      // certain ephemeral payloads). We mark them as deleted in the
      // conversation log so the UI shows a clear "Message deleted"
      // placeholder instead of a cryptic "unrecognized type".
      body = "[הודעה נמחקה]";
      break;

    default:
      body = `[סוג לא מזוהה: ${type}]`;
  }

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
// Media — Meta fetch + Supabase Storage upload
// ─────────────────────────────────────────────────────────────────────────────

async function downloadMetaMedia(
  db: SupabaseAdmin,
  mediaId: string,
  token: string,
): Promise<MetaMediaBlob> {
  const apiVersion = await getMetaApiVersion(db);
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

async function persistDocumentToStorage(
  db: SupabaseAdmin,
  userId: string,
  wamid: string,
  mediaId: string,
  filename: string,
  declaredMime: string | null,
  token: string,
): Promise<PersistedDoc> {
  const blob = await downloadMetaMedia(db, mediaId, token);
  return persistMediaBlobToStorage(db, userId, wamid, blob, filename, declaredMime);
}

async function persistMediaBlobToStorage(
  db: SupabaseAdmin,
  userId: string,
  wamid: string,
  blob: MetaMediaBlob,
  filename: string,
  declaredMime: string | null = null,
): Promise<PersistedDoc> {
  const buf = Buffer.from(blob.base64, "base64");

  const safeName = filename.replace(/[/\\]+/g, "_").slice(0, 200);
  const path = `${userId}/${wamid}-${safeName}`;

  const { error: uploadErr } = await db.storage.from("whatsapp-media").upload(path, buf, {
    contentType: blob.mimeType || declaredMime || "application/octet-stream",
    upsert: true,
  });
  if (uploadErr) throw new Error(`storage upload: ${uploadErr.message}`);

  return { path, filename: safeName, size: buf.length };
}

function filenameForImage(wamid: string, mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg":  "jpg",
    "image/png":  "png",
    "image/webp": "webp",
    "image/gif":  "gif",
  };
  const ext = map[mime.toLowerCase().split(";")[0].trim()] ?? "bin";
  const safeBase = wamid.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
  return `${safeBase}.${ext}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini — audio transcription + image OCR
// ─────────────────────────────────────────────────────────────────────────────

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
}
interface GeminiResponse {
  candidates?: GeminiCandidate[];
}

async function callGemini(
  db: SupabaseAdmin,
  prompt: string,
  base64Data: string,
  mimeType: string,
): Promise<string> {
  const apiKey = await getAppSecret(db, "smrttask", "GEMINI_API_KEY", "GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const model =
    (await getAppSecret(db, "smrttask", "GEMINI_MODEL", "GEMINI_MODEL")) ??
    "gemini-3-flash-preview";
  const thinkingLevel =
    (await getAppSecret(db, "smrttask", "GEMINI_THINKING_LEVEL", "GEMINI_THINKING_LEVEL")) ??
    "low";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingLevel },
    },
  };

  const fetchOnce = async () =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });

  let res = await fetchOnce();
  if (!res.ok && res.status >= 500 && res.status < 600) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await fetchOnce();
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  if (!candidate) return "[Gemini: אין תגובה]";
  if (candidate.finishReason === "SAFETY") return '[Gemini: תוכן נחסם ע"י מסנני בטיחות]';
  if (candidate.finishReason === "RECITATION") return "[Gemini: נחסם בגלל ציטוט ידוע]";

  const text = candidate.content?.parts
    ?.filter((p) => p.text)
    .map((p) => p.text)
    .join("\n");
  return text ?? "[Gemini החזיר תגובה ריקה]";
}

const TRANSCRIPTION_PROMPT =
  "החזר אך ורק את תוכן הדיבור עצמו, מילה במילה. אסור להוסיף ולו מילה אחת משלך.\n" +
  "• המילה הראשונה והמילה האחרונה בפלט חייבות להיות מתוך הדיבור עצמו.\n" +
  "• בלי שום משפט פתיחה (\"הנה התמלול\", \"בטח, הנה...\", \"להלן התמלול:\") ובלי שום משפט סיום (\"מקווה שעזרתי\", \"זהו\", \"בהצלחה\").\n" +
  "• בלי כותרות, בלי סוגריים מטא (כגון [תמלול אודיו]), ובלי markdown fences (```).\n" +
  "• בלי תוויות דובר כמו \"דובר 1:\", \"דובר 2:\" אלא אם יש באמת כמה דוברים שונים בקובץ.\n" +
  "\n" +
  "חוקי תמלול:\n" +
  "• זהה את שפת הדיבור (עברית/אנגלית/יידיש/אחר) ותמלל באותה שפה — אל תתרגם.\n" +
  "• שמור על סימני פיסוק ופסקאות טבעיות.\n" +
  "• אם יש קטע לא ברור — כתוב [לא ברור]. אסור להמציא.\n" +
  "\n" +
  "הפלט שלך נכנס ישירות לצ'אט של המשתמש כאילו הוא הקליד אותו בעצמו.";

function sanitizeTranscript(text: string): string {
  let out = text.trim();

  if (/^```/.test(out)) {
    out = out.replace(/^```[a-zA-Z0-9]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  out = out.replace(/^\[\s*תמלול(?:\s+אודיו)?\s*\]\s*\n*/u, "");

  const HE_META = "תמלול|תרגום|טקסט|פלט|תוצאה|תיאור|פיענוח|קובץ\\s+קולי|הקלטה";
  const EN_META = "transcript(?:ion)?|ocr|text|output|result|translation|description|audio|recording";
  const preamblePatterns: RegExp[] = [
    new RegExp(`^(?:הנה|להלן|בטח[,!:]?\\s*הנה)[^\\n]{0,80}(?:${HE_META})[^\\n]{0,40}:\\s*\\n+`, "iu"),
    new RegExp(`^(?:here(?:'s| is| are|\\s+you\\s+go)|sure[,!:]?\\s*here|below(?:\\s+is)?)[^\\n]{0,80}(?:${EN_META})[^\\n]{0,40}:\\s*\\n+`, "i"),
    new RegExp(`^the\\s+(?:${EN_META})\\s+(?:is|reads|follows)[^\\n]{0,40}:?\\s*\\n+`, "i"),
    /^\*\*[^\n*]{1,80}\*\*\s*\n+/,
    new RegExp(`^(?:${HE_META}|${EN_META})\\s*[:：]\\s*\\n+`, "i"),
  ];
  for (const re of preamblePatterns) {
    const next = out.replace(re, "");
    if (next.length < out.length) { out = next; break; }
  }

  out = out.replace(
    /\n+(hope this helps[^\n]*|let me know if[^\n]*|מקווה שזה עוזר[^\n]*|מקווה שעזרתי[^\n]*|אם יש לך עוד שאלות[^\n]*|אני כאן[^\n]*|בהצלחה[!.]?)\s*$/i,
    "",
  );

  if (/^דובר\s*1\s*[:：]/u.test(out) && !/דובר\s*2\s*[:：]/u.test(out)) {
    out = out.replace(/^דובר\s*1\s*[:：]\s*/u, "");
  }

  return out.trim();
}

async function transcribeAudio(
  db: SupabaseAdmin,
  base64Data: string,
  mimeType: string,
): Promise<string> {
  const raw = await callGemini(db, TRANSCRIPTION_PROMPT, base64Data, mimeType || "audio/ogg");
  return sanitizeTranscript(raw);
}

async function performImageOcr(
  db: SupabaseAdmin,
  base64Data: string,
  mimeType: string,
): Promise<string> {
  const prompt =
    "נתח את התמונה:\n" +
    "1. אם יש טקסט - חלץ אותו במלואו ובדיוק, שמור על מבנה (שורות/פסקאות)\n" +
    "2. אם יש כמה שפות - תמלל כל אחת בשפתה המקורית\n" +
    "3. אם אין טקסט או שהוא מינימלי - תן תיאור תמציתי (1-2 משפטים) של התמונה\n" +
    "4. אם זה צילום מסך של שיחה/מסמך - שמור על פורמט מובן\n" +
    "5. החזר רק את התוצאה, ללא הקדמות";
  return callGemini(db, prompt, base64Data, mimeType || "image/jpeg");
}

// ─────────────────────────────────────────────────────────────────────────────
// source_messages thread refresh
// ─────────────────────────────────────────────────────────────────────────────

async function refreshSourceMessageThread(
  db: SupabaseAdmin,
  userId: string,
  chatId: string,
): Promise<void> {
  const { data: msgs, error } = await db
    .from("whatsapp_messages")
    .select("direction, body_text, received_at, from_phone, from_name, is_history")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .order("received_at", { ascending: false })
    .limit(20);

  if (error) throw new Error(error.message);
  if (!msgs || msgs.length === 0) return;

  // Self-chat detection: the user sent a message to their own WhatsApp
  // number, using their phone as a voice-memo / task-capture channel.
  // We compare digits-only chatId to the connected line's display number.
  let isSelfChat = false;
  {
    const { data: conn } = await db
      .from("whatsapp_connections")
      .select("display_phone_number")
      .eq("user_id", userId)
      .is("disconnected_at", null)
      .maybeSingle();
    const mineDigits = String(conn?.display_phone_number ?? "").replace(/\D/g, "");
    const chatDigits = String(chatId).replace(/\D/g, "");
    isSelfChat = mineDigits.length > 0 && mineDigits === chatDigits;
  }

  const ordered = [...msgs].reverse();
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
    isSelfChat
      ? `Self-chat: true (this is the user talking to their own WhatsApp number — they use it as a voice-memo channel for task capture; every message is a deliberate self-note, treat as ACTIONABLE unless clearly a status remark)`
      : "",
    `\n--- CONVERSATION (last 20 messages) ---`,
    conversationLines,
  ]
    .filter(Boolean)
    .join("\n");

  // For SELF-CHAT we deliberately mark the thread-level row as already
  // classified so the deep classifier doesn't pull it in. The thread row
  // exists only as a context object (kept for the WhatsApp view + future
  // debugging); the *actual* task creation runs off the per-message
  // source_messages we emit below. Without this skip, a self-chat with
  // 8 voice-memo "משימה ל..." entries would still be summarised as a
  // single classifier decision and 7 of the 8 voice memos would be lost
  // — which is the exact bug this whole code path fixes.
  const threadProcessingStatus = isSelfChat ? "classified" : "pending";
  const threadClassification = isSelfChat ? "self_chat_thread_skip" : null;

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
      processing_status: threadProcessingStatus,
      ai_classification: threadClassification,
      metadata: { chatId, chatName, fromPhone, isGroup, isSelfChat },
    },
    { onConflict: "user_id,source_type,source_id" },
  );

  if (upsertErr) throw new Error(upsertErr.message);

  // ── Self-chat: emit one source_message per OUTGOING voice memo ─────────
  // Each is its own classifier candidate, so 8 "משימה ל..." voice memos
  // produce 8 tasks instead of one classification that swallows seven of
  // them. We dedupe on (user_id, source_type='whatsapp_echo', source_id),
  // where source_id is wa:<chatId>:<wamid> — a stable per-message key
  // from the WhatsApp Cloud API. Ignore-duplicates so re-runs after the
  // user sends a new message don't reset processing_status on rows the
  // pipeline has already classified.
  if (isSelfChat) {
    await emitSelfChatPerMessageSourceRows(db, userId, chatId, chatName, fromPhone);
  }
}

/**
 * For a self-chat, look up every OUTGOING whatsapp_message in the chat and
 * upsert a per-message source_message row for it. Idempotent: rows already
 * present are left untouched (ignoreDuplicates), so this is also the
 * backfill path for voice memos that arrived BEFORE the per-message
 * ingestion existed.
 *
 * Bounded to 200 most recent outgoing messages — well above typical
 * backlog size; if someone has more, the older ones can be picked up
 * by widening the limit later. We start narrow to keep webhook latency
 * predictable.
 */
async function emitSelfChatPerMessageSourceRows(
  db: SupabaseAdmin,
  userId: string,
  chatId: string,
  chatName: string,
  fromPhone: string,
): Promise<void> {
  const { data: outgoing, error } = await db
    .from("whatsapp_messages")
    .select("wamid, body_text, received_at, message_type")
    .eq("user_id", userId)
    .eq("chat_id", chatId)
    .eq("direction", "outgoing")
    .order("received_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("[self-chat per-message] fetch outgoing:", error.message);
    return;
  }
  if (!outgoing || outgoing.length === 0) return;

  // Filter out empty bodies (e.g. failed transcripts, empty stickers). A
  // source_message with no text gives the classifier nothing to act on
  // and just costs tokens.
  const rows = outgoing
    .filter((m) => typeof m.wamid === "string" && m.wamid.length > 0)
    .filter((m) => String(m.body_text ?? "").trim().length > 0)
    .map((m) => {
      const text = String(m.body_text ?? "").trim();
      const ts = String(m.received_at ?? "").slice(0, 16);
      const rawContent = [
        `Chat: ${chatName}`,
        `Phone: ${fromPhone}`,
        `Group: false`,
        `Self-chat: true (this is the user talking to their own WhatsApp number — they use it as a voice-memo channel for task capture; every message is a deliberate self-note, treat as ACTIONABLE unless clearly a status remark)`,
        `\n--- MESSAGE ---`,
        `[OUTGOING ${ts}] ${text.replace(/\s+/g, " ")}`,
      ].join("\n");
      return {
        user_id: userId,
        source_type: "whatsapp_echo",
        source_id: `wa:${chatId}:${m.wamid as string}`,
        sender: chatName,
        sender_email: null,
        subject: chatName,
        body_text: text.slice(0, 1000),
        raw_content: rawContent.slice(0, 3000),
        received_at: m.received_at,
        source_url: `https://wa.me/${String(fromPhone).replace(/\D/g, "")}`,
        reply_to_context: fromPhone,
        processing_status: "pending",
        metadata: { chatId, chatName, fromPhone, wamid: m.wamid, message_type: m.message_type },
      };
    });

  if (rows.length === 0) return;

  const { error: insertErr } = await db.from("source_messages").upsert(
    rows,
    { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true },
  );
  if (insertErr) {
    console.error("[self-chat per-message] upsert:", insertErr.message);
  }
}
