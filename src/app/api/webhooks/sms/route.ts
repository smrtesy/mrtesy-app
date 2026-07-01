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

  // TEMP DIAGNOSTIC: record every inbound request so we can inspect the SMS
  // Gateway app's real payload shape. Best-effort; remove once confirmed.
  void recordSmsDebug(db, request, rawBody);

  let envelope: SmsWebhookEnvelope;
  try {
    const raw = JSON.parse(rawBody) as SmsWebhookEnvelope;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ ok: false, error: "shape_invalid" }, { status: 200 });
    }
    envelope = raw;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 200 });
  }

  // Ingest received (incoming) and sent (outgoing) messages — both SMS and MMS.
  // US carriers frequently deliver even short texts as MMS, which fires the
  // mms:* events, so we must handle those too. Ack everything else (delivered/
  // failed receipts, data-SMS) so the gateway moves on.
  const event = envelope.event ?? "";
  const isIncoming = event === "sms:received" || event === "mms:received";
  const isOutgoing = event === "sms:sent" || event === "mms:sent";
  if (!isIncoming && !isOutgoing) {
    return NextResponse.json({ ok: true, ignored: event || "unknown" }, { status: 200 });
  }

  const deviceId = String(envelope.deviceId ?? "").trim();
  if (!deviceId) {
    console.warn("[sms-webhook] event with no deviceId, dropping");
    return NextResponse.json({ ok: false, error: "no_device" }, { status: 200 });
  }

  const conn = await resolveConnection(db, deviceId);
  if (!conn) {
    console.warn(`[sms-webhook] no active connection for deviceId=${deviceId}, dropping`);
    return NextResponse.json({ ok: false, error: "unknown_device" }, { status: 200 });
  }

  // Authentication. A connection with no secret cannot be verified, so we
  // refuse to ingest rather than trust an unauthenticated request.
  if (!conn.signingKey) {
    console.error(`[sms-webhook] no secret for deviceId=${deviceId}, refusing unverified ingest`);
    return NextResponse.json({ ok: false, error: "no_signing_key" }, { status: 200 });
  }
  const authed = authenticateRequest(request, rawBody, conn.signingKey);
  if (!authed.ok) {
    console.warn(`[sms-webhook] auth failed (${authed.reason}) for deviceId=${deviceId}`);
    return NextResponse.json({ ok: false, error: authed.reason }, { status: 200 });
  }

  try {
    await ingestSms(db, conn.userId, deviceId, isIncoming, envelope.payload ?? {});
  } catch (err) {
    console.error("[sms-webhook] ingest error:", err);
    return NextResponse.json({ ok: false, error: "ingest_failed" }, { status: 500 });
  }

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

// TEMP DIAGNOSTIC helper — logs the raw inbound webhook (payload shape, headers,
// query) into sms_webhook_debug so we can see exactly what the app sends.
// Remove once SMS delivery is verified end-to-end.
async function recordSmsDebug(db: SupabaseAdmin, request: NextRequest, rawBody: string): Promise<void> {
  try {
    let payload: unknown = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      /* keep raw only */
    }
    await db.from("sms_webhook_debug").insert({
      query: new URL(request.url).search,
      headers: {
        "content-type": request.headers.get("content-type"),
        "x-signature": request.headers.get("x-signature") ? "present" : null,
        "x-timestamp": request.headers.get("x-timestamp"),
        "user-agent": request.headers.get("user-agent"),
      },
      payload: payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null,
      raw: rawBody.slice(0, 4000),
    });
  } catch (e) {
    console.error("[sms-webhook] debug insert failed:", e instanceof Error ? e.message : e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

async function ingestSms(
  db: SupabaseAdmin,
  userId: string,
  deviceId: string,
  isIncoming: boolean,
  payload: SmsReceivedPayload,
): Promise<void> {
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
    return;
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
  //    nothing to classify.
  if (isOtp) return;
  if (body.trim().length === 0) return;

  const dirLabel = isIncoming ? "INCOMING" : "OUTGOING";
  const subject = isIncoming ? `SMS מ-${peer}` : `SMS ל-${peer}`;
  const rawContent = [
    `SMS conversation with: ${peer}`,
    `Direction: ${dirLabel}${isIncoming ? "" : " (sent by the user)"}`,
    `Time: ${receivedAt}`,
    `\n--- MESSAGE ---`,
    `[${dirLabel}] ${body.replace(/\s+/g, " ").trim()}`,
  ].join("\n");

  const { error: srcErr } = await db.from("source_messages").upsert(
    {
      user_id: userId,
      source_type: "sms",
      source_id: `sms:${messageId}`,
      sender: peer,
      sender_email: null,
      subject,
      body_text: body.slice(0, 1000),
      raw_content: rawContent.slice(0, 3000),
      received_at: receivedAt,
      // Carry the exact peer so the in-app SMS reader can match the thread; also
      // a valid sms: URI as a mobile fallback (opens the native SMS app).
      source_url: `sms:${peer}`,
      reply_to_context: peer,
      processing_status: "pending",
      ai_classification: null,
      metadata: { peerPhone: peer, direction: isIncoming ? "incoming" : "outgoing", deviceId, messageId, channel: "sms" },
    },
    { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true },
  );
  if (srcErr) throw new Error(`source_messages upsert: ${srcErr.message}`);
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
