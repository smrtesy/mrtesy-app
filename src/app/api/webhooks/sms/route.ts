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
  /** The device's own receiving number; may be null. */
  recipient?: string;
  simNumber?: number | null;
  receivedAt?: string;
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

  // We only ingest received SMS. Ack everything else (sent/delivered/failed,
  // MMS, data-SMS) so the gateway treats them as handled and moves on.
  if (envelope.event !== "sms:received") {
    return NextResponse.json({ ok: true, ignored: envelope.event ?? "unknown" }, { status: 200 });
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

  // Signature verification. A connection with no signing key cannot be verified,
  // so we refuse to ingest it rather than trust an unsigned request.
  if (!conn.signingKey) {
    console.error(`[sms-webhook] no signing key for deviceId=${deviceId}, refusing unverified ingest`);
    return NextResponse.json({ ok: false, error: "no_signing_key" }, { status: 200 });
  }
  const sigOk = verifySignature(request, rawBody, conn.signingKey);
  if (!sigOk.ok) {
    console.warn(`[sms-webhook] signature check failed (${sigOk.reason}) for deviceId=${deviceId}`);
    return NextResponse.json({ ok: false, error: sigOk.reason }, { status: 200 });
  }

  try {
    await ingestReceivedSms(db, conn.userId, deviceId, envelope.payload ?? {});
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

async function ingestReceivedSms(
  db: SupabaseAdmin,
  userId: string,
  deviceId: string,
  payload: SmsReceivedPayload,
): Promise<void> {
  const messageId = String(payload.messageId ?? "").trim();
  const sender = String(payload.sender ?? payload.phoneNumber ?? "").trim();
  const body = String(payload.message ?? "");
  if (!messageId || !sender) {
    console.warn("[sms-webhook] payload missing messageId/sender, skipping");
    return;
  }

  const receivedAt = parseReceivedAt(payload.receivedAt);
  const simNumber =
    typeof payload.simNumber === "number" && Number.isFinite(payload.simNumber)
      ? payload.simNumber
      : null;
  const isOtp = looksLikeOtp(body);

  // 1. Durable record of the SMS (idempotent on re-delivery). OTP codes are
  //    kept here for audit but go no further.
  const { error: smsErr } = await db.from("sms_messages").upsert(
    {
      user_id: userId,
      message_id: messageId,
      device_id: deviceId,
      direction: "incoming",
      from_phone: sender,
      to_phone: payload.recipient ?? null,
      sim_number: simNumber,
      body_text: body,
      is_otp: isOtp,
      received_at: receivedAt,
      raw_payload: payload as Record<string, unknown>,
    },
    { onConflict: "user_id,message_id", ignoreDuplicates: false },
  );
  if (smsErr) throw new Error(`sms_messages upsert: ${smsErr.message}`);

  // 2. OTP / verification codes never reach the AI pipeline.
  if (isOtp) return;
  // Nothing actionable in an empty body either.
  if (body.trim().length === 0) return;

  const digits = sender.replace(/[^\d+]/g, "");
  const subject = `SMS מ-${sender}`;
  const rawContent = [
    `SMS from: ${sender}`,
    `Received: ${receivedAt}`,
    `\n--- MESSAGE ---`,
    body.replace(/\s+/g, " ").trim(),
  ].join("\n");

  const { error: srcErr } = await db.from("source_messages").upsert(
    {
      user_id: userId,
      source_type: "sms",
      source_id: `sms:${messageId}`,
      sender,
      sender_email: null,
      subject,
      body_text: body.slice(0, 1000),
      raw_content: rawContent.slice(0, 3000),
      received_at: receivedAt,
      source_url: digits ? `sms:${digits}` : null,
      reply_to_context: sender,
      processing_status: "pending",
      ai_classification: null,
      metadata: { fromPhone: sender, deviceId, messageId, channel: "sms" },
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
