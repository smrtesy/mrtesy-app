/**
 * SMS inbound webhook — Vercel Route Handler.
 *
 * Receives SMS forwarded from the user's own Android phone by the open-source
 * "SMS Gateway for Android" app (https://sms-gate.app), running in local or
 * self-hosted mode so message content never transits the gateway author's
 * cloud. The app POSTs one request per received SMS, signed with HMAC-SHA256.
 *
 * Flow per POST:
 *   1. Read the raw body (needed verbatim for HMAC verification).
 *   2. Parse the envelope; act only on `sms:received` events.
 *   3. Resolve the gateway deviceId → sms_connections row → user_id + the
 *      per-device signing key (from Vault, or the SMS_GATEWAY_SIGNING_KEY env
 *      fallback during initial setup).
 *   4. Verify X-Signature = HMAC-SHA256(key, rawBody + X-Timestamp) and reject
 *      stale timestamps (>5 min) to block replays. Unverifiable → drop.
 *   5. Upsert the message into sms_messages (idempotent on user_id+messageId,
 *      so a gateway re-delivery is a no-op).
 *   6. Unless it looks like a one-time/verification code, upsert a per-message
 *      row into source_messages (source_type='sms', pending) so the ai-process
 *      pipeline classifies it and creates a task — exactly like WhatsApp/Gmail.
 *      OTP/2FA codes are stored in sms_messages only and never reach the AI.
 *   7. Return 200 on soft failures (unknown device, bad signature) so the
 *      gateway does not retry-storm; only true server faults bubble up.
 */

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

// Node runtime: we need `node:crypto`, `Buffer`, and the full Supabase client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reject timestamps further than this from now (seconds) — replay protection.
const MAX_CLOCK_SKEW_SECONDS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// Types — minimal shape of the SMS Gateway webhook payload
// ─────────────────────────────────────────────────────────────────────────────

interface SmsReceivedPayload {
  messageId?: string;
  message?: string;
  /** Originating phone number (preferred over the deprecated `phoneNumber`). */
  sender?: string;
  phoneNumber?: string;
  /** The device's own receiving number (incoming) / the destination (outgoing). */
  recipient?: string;
  simNumber?: number | null;
  receivedAt?: string;
  /** Outgoing (sms:sent) timestamp field. */
  sentAt?: string;
  /** MMS carries its text under different keys depending on the message. */
  text?: string;
  subject?: string;
}

interface SmsWebhookEnvelope {
  deviceId?: string;
  event?: string;
  id?: string;
  webhookId?: string;
  payload?: SmsReceivedPayload;
}

type SupabaseAdmin = NonNullable<ReturnType<typeof createAdminSupabaseClient>>;

interface ResolvedSmsConnection {
  userId: string;
  /** Decrypted HMAC signing key, or null if neither Vault nor env has one. */
  signingKey: string | null;
}

/** What ingestSms did with a payload — surfaced to the diagnostic log. */
interface IngestResult {
  outcome: "ingested" | "skipped";
  /** otp_suppressed | empty_body | missing_fields | null */
  reason: string | null;
  direction: "incoming" | "outgoing";
  messageId: string;
  peer: string;
  bodyPreview: string;
}

/** One diagnostic row written to sms_webhook_debug for every webhook hit. */
interface WebhookDebugRow {
  user_id?: string | null;
  device_id?: string | null;
  event?: string | null;
  direction?: string | null;
  outcome: "ingested" | "ignored" | "dropped";
  reason?: string | null;
  message_id?: string | null;
  peer?: string | null;
  body_preview?: string | null;
  payload?: Record<string, unknown> | null;
}

/**
 * Best-effort diagnostic log of a single webhook hit + its outcome. Never
 * throws — a logging failure must not affect the webhook response. Mirrors the
 * smrtbot / whatsapp webhook_debug pattern.
 */
async function recordWebhookDebug(db: SupabaseAdmin, row: WebhookDebugRow): Promise<void> {
  try {
    const { error } = await db.from("sms_webhook_debug").insert({
      user_id: row.user_id ?? null,
      device_id: row.device_id ?? null,
      event: row.event ?? null,
      direction: row.direction ?? null,
      outcome: row.outcome,
      reason: row.reason ?? null,
      message_id: row.message_id ?? null,
      peer: row.peer ?? null,
      body_preview: row.body_preview ? row.body_preview.slice(0, 200) : null,
      payload: row.payload ?? null,
    });
    if (error) console.error("[sms-webhook] debug insert failed:", error.message);
  } catch (e) {
    console.error("[sms-webhook] debug insert threw:", e instanceof Error ? e.message : e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST — main webhook receiver
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text();

  const db = createAdminSupabaseClient();
  if (!db) {
    console.error("[sms-webhook] SUPABASE_SERVICE_ROLE_KEY missing");
    return NextResponse.json({ ok: false, error: "server_misconfigured" }, { status: 500 });
  }

  let envelope: SmsWebhookEnvelope;
  try {
    const raw = JSON.parse(rawBody) as SmsWebhookEnvelope;
    if (!raw || typeof raw !== "object") {
      await recordWebhookDebug(db, {
        outcome: "dropped",
        reason: "shape_invalid",
        payload: { raw: rawBody.slice(0, 500) },
      });
      return NextResponse.json({ ok: false, error: "shape_invalid" }, { status: 200 });
    }
    envelope = raw;
  } catch {
    await recordWebhookDebug(db, {
      outcome: "dropped",
      reason: "invalid_json",
      payload: { raw: rawBody.slice(0, 500) },
    });
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 200 });
  }

  // Best-effort identifiers available before connection resolution — recorded on
  // every diagnostic row, including the ones we drop.
  const envDeviceId = String(envelope.deviceId ?? "").trim() || null;

  // Ingest received (incoming) and sent (outgoing) messages — both SMS and MMS.
  // US carriers frequently deliver even short texts as MMS, which fires the
  // mms:* events, so we must handle those too. Ack everything else (delivered/
  // failed receipts, data-SMS) so the gateway moves on.
  const event = envelope.event ?? "";
  const isIncoming = event === "sms:received" || event === "mms:received";
  // `sms:sent-observed` / `mms:sent-observed` are emitted by our forked gateway
  // when the user sends an SMS/MMS manually from the phone's own messaging app
  // (observed in content://sms/sent and the content://mms sent-box). Their
  // payload carries recipient/message/sentAt/messageId, which ingestSms already
  // maps for outgoing messages.
  //
  // Its messageId is the Android provider row `_id`, whereas `sms:sent` (a send
  // the gateway itself performed via its API) carries the gateway's own id. If
  // gateway-originated sending is ever enabled here, the same physical SMS could
  // arrive under both events with different ids and ingest twice; that path is
  // intentionally deferred today, so observed sends are the only outgoing source.
  const isOutgoing =
    event === "sms:sent" ||
    event === "mms:sent" ||
    event === "sms:sent-observed" ||
    event === "mms:sent-observed";
  if (!isIncoming && !isOutgoing) {
    await recordWebhookDebug(db, {
      device_id: envDeviceId,
      event,
      outcome: "ignored",
      reason: `ignored:${event || "unknown"}`,
      payload: envelope.payload as Record<string, unknown> | undefined,
    });
    return NextResponse.json({ ok: true, ignored: event || "unknown" }, { status: 200 });
  }

  const deviceId = String(envelope.deviceId ?? "").trim();
  if (!deviceId) {
    console.warn("[sms-webhook] event with no deviceId, dropping");
    await recordWebhookDebug(db, { event, outcome: "dropped", reason: "no_device" });
    return NextResponse.json({ ok: false, error: "no_device" }, { status: 200 });
  }

  let conn = await resolveConnection(db, deviceId);
  if (!conn) {
    // A reinstall mints a new deviceId; adopt it onto the connection whose
    // secret matches the URL token instead of dropping every message until the
    // mapping is fixed by hand.
    const urlToken = new URL(request.url).searchParams.get("token");
    conn = await adoptDeviceByToken(db, deviceId, urlToken);
  }
  if (!conn) {
    console.warn(`[sms-webhook] no active connection for deviceId=${deviceId}, dropping`);
    await recordWebhookDebug(db, {
      device_id: deviceId,
      event,
      outcome: "dropped",
      reason: "unknown_device",
    });
    return NextResponse.json({ ok: false, error: "unknown_device" }, { status: 200 });
  }

  // Authentication. A connection with no secret cannot be verified, so we
  // refuse to ingest rather than trust an unauthenticated request.
  if (!conn.signingKey) {
    console.error(`[sms-webhook] no secret for deviceId=${deviceId}, refusing unverified ingest`);
    await recordWebhookDebug(db, {
      user_id: conn.userId,
      device_id: deviceId,
      event,
      outcome: "dropped",
      reason: "no_signing_key",
    });
    return NextResponse.json({ ok: false, error: "no_signing_key" }, { status: 200 });
  }
  const authed = authenticateRequest(request, rawBody, conn.signingKey);
  if (!authed.ok) {
    console.warn(`[sms-webhook] auth failed (${authed.reason}) for deviceId=${deviceId}`);
    await recordWebhookDebug(db, {
      user_id: conn.userId,
      device_id: deviceId,
      event,
      outcome: "dropped",
      reason: `auth:${authed.reason}`,
    });
    return NextResponse.json({ ok: false, error: authed.reason }, { status: 200 });
  }

  let result: IngestResult;
  try {
    result = await ingestSms(db, conn.userId, deviceId, isIncoming, envelope.payload ?? {});
  } catch (err) {
    console.error("[sms-webhook] ingest error:", err);
    await recordWebhookDebug(db, {
      user_id: conn.userId,
      device_id: deviceId,
      event,
      direction: isIncoming ? "incoming" : "outgoing",
      outcome: "dropped",
      reason: "ingest_failed",
      payload: envelope.payload as Record<string, unknown> | undefined,
    });
    return NextResponse.json({ ok: false, error: "ingest_failed" }, { status: 500 });
  }

  await recordWebhookDebug(db, {
    user_id: conn.userId,
    device_id: deviceId,
    event,
    direction: result.direction,
    outcome: result.outcome === "ingested" ? "ingested" : "dropped",
    reason: result.reason,
    message_id: result.messageId || null,
    peer: result.peer || null,
    body_preview: result.bodyPreview || null,
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection resolution + signature verification
// ─────────────────────────────────────────────────────────────────────────────

async function resolveConnection(
  db: SupabaseAdmin,
  deviceId: string,
): Promise<ResolvedSmsConnection | null> {
  const { data, error } = await db
    .from("sms_connections")
    .select("user_id, signing_key_id")
    .eq("device_id", deviceId)
    .is("disconnected_at", null)
    .maybeSingle();
  if (error) {
    console.error("[sms-webhook] resolveConnection failed:", error.message);
    return null;
  }
  const userId = (data?.user_id as string | undefined) ?? null;
  if (!userId) return null;

  let signingKey: string | null = null;
  const secretId = (data?.signing_key_id as string | null | undefined) ?? null;
  if (secretId) {
    const { data: plaintext, error: vaultErr } = await db.rpc("vault_read_secret", {
      secret_id: secretId,
    });
    if (vaultErr) {
      console.error(`[sms-webhook] vault_read_secret(${secretId}) failed:`, vaultErr.message);
    } else if (typeof plaintext === "string") {
      signingKey = plaintext;
    }
  }
  // Env fallback for initial single-device setup before a key is stored.
  if (!signingKey) signingKey = process.env.SMS_GATEWAY_SIGNING_KEY ?? null;

  return { userId, signingKey };
}

/**
 * deviceId auto-heal. Reinstalling the SMS Gateway app mints a fresh deviceId,
 * which orphans the registered connection — every webhook then drops as
 * unknown_device until the mapping is fixed by hand. Since the URL token IS the
 * connection's bearer secret, a webhook presenting a token that matches an
 * active connection is already authorized for it, so we adopt the new deviceId
 * onto that connection and proceed. deviceId is only a routing hint; the token
 * is the credential, so this grants nothing a valid token didn't already.
 *
 * Matched by the token's SHA-256 against the stored `signing_key_sha256` — a
 * single indexed lookup, so an unauthenticated unknown-device flood can't
 * amplify into per-connection Vault reads. The plaintext key is still read from
 * Vault once, for a defence-in-depth constant-time compare before adopting.
 */
async function adoptDeviceByToken(
  db: SupabaseAdmin,
  deviceId: string,
  token: string | null,
): Promise<ResolvedSmsConnection | null> {
  if (!token) return null;

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const { data, error } = await db
    .from("sms_connections")
    .select("id, user_id, signing_key_id")
    .eq("signing_key_sha256", tokenHash)
    .is("disconnected_at", null)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[sms-webhook] adoptDeviceByToken query failed:", error.message);
    return null;
  }
  if (!data) return null;

  // Confirm the real key from Vault matches (guards against a hash collision or
  // a stale hash), in constant time, before repointing the connection.
  const secretId = (data.signing_key_id as string | null | undefined) ?? null;
  if (!secretId) return null;
  const { data: secret, error: vaultErr } = await db.rpc("vault_read_secret", {
    secret_id: secretId,
  });
  if (vaultErr || typeof secret !== "string" || !timingSafeEqual(token, secret)) {
    return null;
  }

  const { error: updErr } = await db
    .from("sms_connections")
    .update({ device_id: deviceId })
    .eq("id", data.id as string);
  if (updErr) {
    console.error("[sms-webhook] adoptDeviceByToken update failed:", updErr.message);
    return null;
  }
  console.warn(
    `[sms-webhook] adopted new deviceId=${deviceId} onto connection ${data.id} via token match`,
  );
  return { userId: data.user_id as string, signingKey: secret };
}

/**
 * Authenticate an inbound webhook against the device's shared secret. Two
 * accepted proofs, in priority order:
 *
 *   1. Secret token in the URL — `?token=<secret>`. This is the path used by
 *      the SMS Gateway for Android app, whose current build forwards a stored
 *      URL verbatim but exposes no UI to share its own HMAC signing key with
 *      us. The token rides inside the HTTPS-encrypted URL and is compared in
 *      constant time. Replay isn't a concern: ingestion is idempotent on
 *      (user_id, messageId), so a replayed body is a no-op upsert.
 *   2. HMAC-SHA256 over `rawBody + X-Timestamp` (hex, ±300s freshness) — the
 *      stronger proof, kept for any client that CAN be configured with our
 *      signing key.
 */
function authenticateRequest(
  request: NextRequest,
  rawBody: string,
  secret: string,
): { ok: true } | { ok: false; reason: string } {
  const token = new URL(request.url).searchParams.get("token");
  if (token) {
    return timingSafeEqual(token, secret) ? { ok: true } : { ok: false, reason: "bad_token" };
  }
  if (request.headers.get("x-signature")) {
    return verifySignature(request, rawBody, secret);
  }
  return { ok: false, reason: "missing_auth" };
}

function verifySignature(
  request: NextRequest,
  rawBody: string,
  signingKey: string,
): { ok: true } | { ok: false; reason: string } {
  const sig = request.headers.get("x-signature") ?? "";
  const tsHeader = request.headers.get("x-timestamp") ?? "";
  if (!sig || !tsHeader) return { ok: false, reason: "missing_signature" };

  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: "stale_timestamp" };

  // The gateway signs the raw body concatenated with the X-Timestamp value.
  const expected = crypto
    .createHmac("sha256", signingKey)
    .update(rawBody + tsHeader)
    .digest("hex");
  if (!timingSafeEqual(sig.toLowerCase(), expected)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

// Rolling-transcript constants (mirror the WhatsApp thread builder).
const SMS_CONVO_BUDGET = 2600;
const SMS_MAX_MSG_CHARS = 400;

function fmtTsLocal(iso: string, tz: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso ?? "").slice(0, 16);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

async function smsUserTz(db: SupabaseAdmin, userId: string): Promise<string> {
  const { data } = await db.from("user_settings").select("timezone").eq("user_id", userId).maybeSingle();
  return String(data?.timezone ?? "").trim() || "Asia/Jerusalem";
}

/**
 * Assemble a rolling [INCOMING]/[OUTGOING] transcript for an SMS conversation —
 * the SMS twin of WhatsApp's refreshSourceMessageThread — so the AI classifier
 * sees the whole thread, not one isolated message. Writes ONE per-burst
 * source_messages row keyed sms:<peer>:<latestMessageId>, stamps
 * metadata.chatId=<peer> (every downstream thread gate keys off chatId), and
 * supersedes earlier still-pending SMS bursts for the same peer so only the
 * newest transcript reaches the classifier (burst coalescing).
 */
async function refreshSmsSourceThread(
  db: SupabaseAdmin,
  userId: string,
  peer: string,
): Promise<void> {
  const { data: msgs, error } = await db
    .from("sms_messages")
    .select("message_id, direction, body_text, received_at, is_otp")
    .eq("user_id", userId)
    .or(`from_phone.eq.${peer},to_phone.eq.${peer}`)
    .order("received_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`sms thread query: ${error.message}`);
  const usable = (msgs ?? []).filter(
    (m) => !m.is_otp && String(m.body_text ?? "").trim().length > 0,
  );
  if (usable.length === 0) return;

  const tz = await smsUserTz(db, userId);
  const ordered = [...usable].reverse(); // oldest → newest

  // Keep the NEWEST lines within the budget (drop oldest first) — the classifier
  // reasons about the last line, so the tail must survive.
  const lines: string[] = [];
  let budget = SMS_CONVO_BUDGET;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const m = ordered[i];
    const dir = String(m.direction ?? "incoming").toUpperCase();
    const ts = fmtTsLocal(String(m.received_at ?? ""), tz);
    let text = String(m.body_text ?? "").replace(/\s+/g, " ").trim();
    if (text.length > SMS_MAX_MSG_CHARS) text = text.slice(0, SMS_MAX_MSG_CHARS) + " …";
    const line = `[${dir} ${ts}] ${text}`;
    if (line.length > budget && lines.length > 0) break;
    budget -= line.length;
    lines.unshift(line);
  }

  const rawContent = [
    `SMS conversation with: ${peer}`,
    `[OUTGOING] = sent by the user, [INCOMING] = the other party.`,
    `\n--- CONVERSATION (oldest to newest) ---`,
    ...lines,
  ].join("\n").slice(0, 3000);

  // Anchor the burst on the NEWEST message in the window (like WhatsApp's
  // last.wamid) so an out-of-order re-delivery refreshes ONE row, not a stale one.
  const latest = ordered[ordered.length - 1];
  const latestMessageId = String(latest.message_id ?? "");
  if (!latestMessageId) return; // no stable key to anchor
  const latestDirection = String(latest.direction ?? "incoming");
  const latestReceivedAt = String(latest.received_at ?? "");
  const subject = latestDirection === "incoming" ? `SMS מ-${peer}` : `SMS ל-${peer}`;
  const burstId = `sms:${peer}:${latestMessageId}`;
  const bodyText = String(latest.body_text ?? "").slice(0, 1000);
  const metadata = {
    chatId: peer,
    peerPhone: peer,
    direction: latestDirection,
    lastDirection: latestDirection,
    channel: "sms",
    messageId: latestMessageId,
  };

  // ignoreDuplicates so a gateway re-delivery of the same latest message doesn't
  // reset a row the pipeline already classified/locked (mirrors WhatsApp).
  const { error: srcErr } = await db.from("source_messages").upsert(
    {
      user_id: userId,
      source_type: "sms",
      source_id: burstId,
      sender: peer,
      sender_email: null,
      subject,
      body_text: bodyText,
      raw_content: rawContent,
      received_at: latestReceivedAt,
      source_url: `sms:${peer}`,
      reply_to_context: peer,
      processing_status: "pending",
      ai_classification: null,
      metadata,
    },
    { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true },
  );
  if (srcErr) throw new Error(`source_messages upsert: ${srcErr.message}`);

  // Refresh the transcript in place ONLY while the burst is still pending and
  // unlocked — a late-arriving message rebuilds a fuller transcript, but an
  // already-classified or in-flight row is never reset (mirrors WhatsApp).
  const { error: refreshErr } = await db
    .from("source_messages")
    .update({ body_text: bodyText, raw_content: rawContent, received_at: latestReceivedAt, metadata })
    .eq("user_id", userId)
    .eq("source_type", "sms")
    .eq("source_id", burstId)
    .eq("processing_status", "pending")
    .is("processing_lock_at", null);
  if (refreshErr) throw new Error(`source_messages refresh: ${refreshErr.message}`);

  // Coalesce: retire earlier still-pending, unlocked SMS bursts for this peer so
  // only the newest transcript reaches the classifier.
  const { error: supErr } = await db
    .from("source_messages")
    .update({
      processing_status: "processed",
      ai_classification: "superseded",
      processed_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("source_type", "sms")
    .eq("processing_status", "pending")
    .is("processing_lock_at", null)
    .filter("metadata->>chatId", "eq", peer)
    .lte("received_at", latestReceivedAt)
    .neq("source_id", burstId);
  if (supErr) console.warn("[sms-webhook] supersede failed:", supErr.message);
}

/**
 * Do two phone numbers identify the same line? Compares digits only, so
 * "+1 929-333-0248" and "19293330248" match. Falls back to a national-suffix
 * compare (last 9 digits) when the two are stored in different formats — a
 * local "050…" vs an international "97250…" — but ONLY for real phone numbers
 * (≥10 digits), so a 5–6 digit short code can never collide with the user's
 * own number on a shared tail.
 */
function numbersMatch(a: string, b: string): boolean {
  const aD = a.replace(/\D/g, "");
  const bD = b.replace(/\D/g, "");
  if (!aD || !bD) return false;
  if (aD === bD) return true;
  if (aD.length >= 10 && bD.length >= 10) {
    return aD.endsWith(bD.slice(-9)) || bD.endsWith(aD.slice(-9));
  }
  return false;
}

/**
 * The device's own phone line, used to recognise a self-note (the user texting
 * their own number as a task-capture channel). Learned from the `recipient`
 * field of any INCOMING sms — that is the device's receiving line — and cached
 * on the connection so an OUTGOING self-note (which carries no self identifier
 * of its own) can still be matched. When the very first message on a fresh
 * connection is an outgoing self-note (no incoming recipient to read), we fall
 * back to the device number recorded on the most recent prior INCOMING sms, so
 * detection works from the first note as long as any inbound SMS was ever seen.
 * Returns null only when the number has never been observed.
 */
async function resolveOwnNumber(
  db: SupabaseAdmin,
  userId: string,
  deviceId: string,
  incomingRecipient: string | null,
): Promise<string | null> {
  const { data, error } = await db
    .from("sms_connections")
    .select("display_phone_number")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) {
    console.error("[sms-webhook] resolveOwnNumber query failed:", error.message);
    return null;
  }
  const stored = String(data?.display_phone_number ?? "").trim();
  if (stored) return stored;

  let learned = String(incomingRecipient ?? "").trim();
  // Cold-start fallback: an outgoing-first self-note carries no self identifier,
  // so read the device's own receiving line from a prior incoming message.
  if (!learned) {
    const { data: recent } = await db
      .from("sms_messages")
      .select("to_phone")
      .eq("user_id", userId)
      .eq("direction", "incoming")
      .not("to_phone", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    learned = String(recent?.to_phone ?? "").trim();
  }
  if (!learned) return null;

  // Cache it, but only fill a NULL column — never overwrite a user-set value.
  const { error: updErr } = await db
    .from("sms_connections")
    .update({ display_phone_number: learned })
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .is("display_phone_number", null);
  if (updErr) console.error("[sms-webhook] cache own number failed:", updErr.message);
  return learned;
}

/**
 * SMS self-note (the user texting their OWN number). Mirrors the WhatsApp
 * self-chat path (emitSelfChatPerMessageSourceRows): write ONE immutable
 * source_messages row PER message with source_type='sms_echo', so every note is
 * its own classifier candidate and becomes its own task — instead of the
 * two-party thread builder coalescing a burst of 8 notes into a single
 * classification and losing 7 of them (the reported bug). No supersede/coalesce,
 * no thread key. ai-process treats sms_echo exactly like whatsapp_echo.
 */
async function emitSmsSelfNote(
  db: SupabaseAdmin,
  userId: string,
  body: string,
  receivedAt: string,
  ownNumber: string,
): Promise<void> {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return;
  const tz = await smsUserTz(db, userId);
  const ts = fmtTsLocal(receivedAt, tz);
  const rawContent = [
    `SMS self-note — the user texted their OWN number (${ownNumber}) as a task-capture channel.`,
    `Every such message is a deliberate self-note; treat as ACTIONABLE unless clearly a status remark.`,
    `\n--- MESSAGE ---`,
    `[OUTGOING ${ts}] ${text}`,
  ].join("\n").slice(0, 3000);

  // Key the row on the message CONTENT, not its provider messageId. Texting your
  // own number can be delivered TWICE — once as the observed sent-box row and
  // once as the carrier loopback into the inbox — with two different provider
  // ids. Both carry the identical body, so a content hash collapses the pair to
  // ONE row (ignoreDuplicates below no-ops the second). Distinct notes — even
  // several fired within the same second/minute — have distinct bodies and so
  // stay separate, which a time-bucket key would wrongly have merged.
  const bodyKey = crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
  const { error } = await db.from("source_messages").upsert(
    {
      user_id: userId,
      source_type: "sms_echo",
      source_id: `sms:self:${bodyKey}`,
      sender: ownNumber,
      sender_email: null,
      subject: "פתק SMS",
      body_text: text.slice(0, 1000),
      raw_content: rawContent,
      received_at: receivedAt,
      source_url: `sms:${ownNumber}`,
      reply_to_context: ownNumber,
      processing_status: "pending",
      ai_classification: null,
      // No lastDirection stamp: that key drives the follow-up defer, which would
      // wrongly snooze a self-note (technically an outgoing message). chatId is
      // set for source_url/debug parity only — threadKey returns null for
      // sms_echo, so it never keys thread memory or matter routing.
      metadata: { chatId: ownNumber, peerPhone: ownNumber, channel: "sms", isSelfNote: true },
    },
    { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true },
  );
  if (error) throw new Error(`sms_echo upsert: ${error.message}`);
}

async function ingestSms(
  db: SupabaseAdmin,
  userId: string,
  deviceId: string,
  isIncoming: boolean,
  payload: SmsReceivedPayload,
): Promise<IngestResult> {
  const direction: "incoming" | "outgoing" = isIncoming ? "incoming" : "outgoing";
  const messageId = String(payload.messageId ?? "").trim();
  // The conversation peer is the OTHER party: the sender for an incoming SMS,
  // the recipient for one we sent. `phoneNumber` is the deprecated fallback.
  const peer = String(
    (isIncoming ? payload.sender : payload.recipient) ?? payload.phoneNumber ?? "",
  ).trim();
  // MMS may carry its text under `text`/`subject` rather than `message`.
  const body = String(payload.message ?? payload.text ?? payload.subject ?? "");
  if (!messageId || !peer) {
    console.warn("[sms-webhook] payload missing messageId/peer, skipping");
    return { outcome: "skipped", reason: "missing_fields", direction, messageId, peer, bodyPreview: body };
  }

  const receivedAt = parseReceivedAt(payload.receivedAt ?? payload.sentAt);
  const simNumber =
    typeof payload.simNumber === "number" && Number.isFinite(payload.simNumber)
      ? payload.simNumber
      : null;
  // OTP detection applies only to INCOMING messages — an outgoing SMS the user
  // wrote is never a one-time code to suppress.
  const isOtp = isIncoming ? looksLikeOtp(body) : false;

  // 1. Durable record (idempotent on re-delivery). For outgoing SMS the "from"
  //    is the user's own line, which the gateway doesn't report, so we store a
  //    "me" sentinel (from_phone is NOT NULL) and key threads off the peer.
  const { error: smsErr } = await db.from("sms_messages").upsert(
    {
      user_id: userId,
      message_id: messageId,
      device_id: deviceId,
      direction: isIncoming ? "incoming" : "outgoing",
      from_phone: isIncoming ? peer : "me",
      to_phone: isIncoming ? (payload.recipient ?? null) : peer,
      sim_number: simNumber,
      body_text: body,
      is_otp: isOtp,
      received_at: receivedAt,
      raw_payload: payload as Record<string, unknown>,
    },
    { onConflict: "user_id,message_id", ignoreDuplicates: false },
  );
  if (smsErr) throw new Error(`sms_messages upsert: ${smsErr.message}`);

  // 2. OTP / verification codes never reach the AI pipeline; empty bodies have
  //    nothing to classify. Both are still recorded in sms_messages above.
  if (isOtp) return { outcome: "ingested", reason: "otp_suppressed", direction, messageId, peer, bodyPreview: body };
  if (body.trim().length === 0) return { outcome: "ingested", reason: "empty_body", direction, messageId, peer, bodyPreview: body };

  // 3. Self-note: the user texting their OWN number as a task-capture channel —
  //    the SMS twin of WhatsApp self-chat. The device's own line is the
  //    `recipient` on any INCOMING sms; learn it once, cache it, then a message
  //    whose peer matches it is a deliberate self-note. These bypass the
  //    two-party thread builder (which would coalesce a burst and lose all but
  //    the newest) and get ONE immutable sms_echo row per message — each its own
  //    task, exactly like whatsapp_echo.
  const ownNumber = await resolveOwnNumber(db, userId, deviceId, isIncoming ? (payload.recipient ?? null) : null);
  const isSelfNote = !!ownNumber && numbersMatch(peer, ownNumber);
  if (isSelfNote) {
    await emitSmsSelfNote(db, userId, body, receivedAt, ownNumber!);
    return { outcome: "ingested", reason: "self_note", direction, messageId, peer, bodyPreview: body };
  }

  // Build the rolling conversation transcript for this peer and write ONE
  // per-burst source_messages row (mirrors WhatsApp) so the classifier sees the
  // whole thread — not this message in isolation — and can understand a reply
  // like "Mistake, I didn't pay" in context.
  await refreshSmsSourceThread(db, userId, peer);

  return { outcome: "ingested", reason: null, direction, messageId, peer, bodyPreview: body };
}

/**
 * Parse the gateway's local ISO timestamp. Falls back to now() when absent or
 * unparseable so a row is never dropped over a missing field.
 */
function parseReceivedAt(raw: string | undefined): string {
  if (raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/**
 * Conservative heuristic for one-time-password / verification SMS, so banking
 * and 2FA codes are recorded but never turned into tasks or sent to the AI.
 * Requires BOTH a short numeric code AND a verification keyword (he/en), plus
 * a couple of unambiguous provider markers (Google "G-123456", the Android
 * SMS Retriever "<#>" hash).
 */
function looksLikeOtp(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\bG-\d{4,8}\b/.test(t)) return true; // Google verification SMS
  if (t.includes("<#>")) return true; // Android SMS Retriever app-hash marker
  const hasCode = /(?<!\d)\d{4,8}(?!\d)/.test(t);
  if (!hasCode) return false;
  const keyword =
    /(code|otp|one[\s-]?time|verification|verify|verif\.?|passcode|password|\bpin\b|2fa|two[\s-]?factor|authenticat|login|log[\s-]?in|sign[\s-]?in|קוד|אימות|סיסמ|חד[\s-]?פעמי|אסימון|התחבר|כניס)/i;
  return keyword.test(t);
}
