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
 *   5. MMS attachments (if the payload carries any): store the bytes in the
 *      sms-media bucket and run them through the SAME Gemini helpers the
 *      WhatsApp webhook uses — images get OCR, audio gets transcribed — so the
 *      resulting text becomes the message body the classifier reads.
 *   6. Upsert the message into sms_messages (idempotent on user_id+messageId,
 *      so a gateway re-delivery is a no-op).
 *   7. Unless it looks like a one-time/verification code, upsert a per-message
 *      row into source_messages (source_type='sms', pending) so the ai-process
 *      pipeline classifies it and creates a task — exactly like WhatsApp/Gmail.
 *      OTP/2FA codes are stored in sms_messages only and never reach the AI.
 *   8. Return 200 on soft failures (unknown device, bad signature) so the
 *      gateway does not retry-storm; only true server faults bubble up.
 */

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import {
  AUDIO_TRANSCRIBE_MAX_BYTES,
  performImageOcr,
  transcribeAudio,
} from "@/lib/media/gemini";

// Node runtime: we need `node:crypto`, `Buffer`, and the full Supabase client.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// An MMS with attachments does a Storage upload plus one Gemini call per part;
// the default serverless timeout (~10-15s) is not enough and a timeout makes
// the gateway redeliver the whole payload. 60s is Vercel's cross-plan maximum,
// same as the WhatsApp webhook.
export const maxDuration = 60;

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
  /** `mms:downloaded` carries the message text here (with `subject`/attachments). */
  body?: string;
  /**
   * MMS parts. The UPSTREAM gateway never sends these — its `mms:received`
   * payload is metadata only (`size`, `contentClass`), verified against
   * docs.sms-gate.app and against three weeks of production `raw_payload`
   * rows, none of which carried a single media field. They arrive only from
   * our fork's `mms:downloaded` / `mms:sent-observed` events, which read
   * `content://mms/part` on the phone. Contract + Kotlin patch spec:
   * docs/sms-mms-media-handoff.md.
   *
   * `parts` is accepted as an alias because the Android side names the
   * provider table that way; a naming slip between the two repos must not
   * silently drop media, which is the exact failure this whole change fixes.
   */
  attachments?: SmsAttachmentPayload[];
  parts?: SmsAttachmentPayload[];
}

/** One MMS part as the fork sends it: metadata + the bytes, base64-encoded. */
interface SmsAttachmentPayload {
  /** MIME type, e.g. "image/jpeg", "audio/amr". `mimeType`/`type` are aliases. */
  contentType?: string;
  mimeType?: string;
  type?: string;
  /** Base64 of the raw bytes. `base64`/`content` are aliases. */
  data?: string;
  base64?: string;
  content?: string;
  /** Original filename as the sender's device named it. `name` is an alias. */
  filename?: string;
  name?: string;
}

/** A normalized, decoded attachment ready to store and analyse. */
interface NormalizedAttachment {
  buf: Buffer;
  mime: string;
  filename: string;
  kind: "image" | "audio" | "video" | "file";
}

/** What we persist in sms_messages.media_parts (see the migration's comment). */
interface StoredMediaPart {
  path: string;
  mime: string;
  filename: string;
  size: number;
  kind: NormalizedAttachment["kind"];
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
  // `mms:downloaded` is what actually fires for an incoming MMS on this fork:
  // the MmsContentObserver picks up the fully-downloaded inbox row and emits it
  // WITH the message body (unlike `mms:received`, which is the pre-download
  // header notification, carries no text, and only fires from the WAP-push
  // broadcast that a non-default app never receives). Treat both as incoming.
  const isIncoming =
    event === "sms:received" || event === "mms:received" || event === "mms:downloaded";
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
      payload: envelope.payload ? payloadForStorage(envelope.payload) : undefined,
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
    result = await ingestSms(db, conn.userId, deviceId, isIncoming, envelope.payload ?? {}, event);
  } catch (err) {
    console.error("[sms-webhook] ingest error:", err);
    await recordWebhookDebug(db, {
      user_id: conn.userId,
      device_id: deviceId,
      event,
      direction: isIncoming ? "incoming" : "outgoing",
      outcome: "dropped",
      reason: "ingest_failed",
      payload: envelope.payload ? payloadForStorage(envelope.payload) : undefined,
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

// ─────────────────────────────────────────────────────────────────────────────
// MMS attachments — Storage + Gemini transcription / OCR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap on how many parts of ONE message we send to Gemini. Every part is stored
 * and shown in the reader; only the analysis is capped, because each part is a
 * paid call on a 60s serverless budget. Four covers every real MMS we have
 * seen. When a message exceeds it the body says so explicitly — a silent cap
 * would read to the classifier (and to the user) as "that's all there was".
 */
const MAX_MEDIA_AI_PARTS = 4;

/** Hard cap on parts stored per message — bounds the Storage work per webhook. */
const MAX_MEDIA_STORED_PARTS = 10;

/**
 * Wall-clock budget for the whole analysis pass, measured from its start. Past
 * it, remaining parts are stored but not analysed.
 *
 * This is what makes the redelivery guard in ingestSms actually reachable. The
 * guard reads a row that is only written AFTER analysis, so if analysis ran past
 * the function's `maxDuration` the process would die having written nothing, the
 * gateway would redeliver, and the whole paid batch would run again — with
 * nothing to stop it repeating. Together with the per-call timeout inside
 * @/lib/media/gemini, this keeps the pass inside the 60s budget so the row is
 * always written and a redelivery is always a no-op.
 */
const MEDIA_ANALYSIS_BUDGET_MS = 40_000;

/**
 * Thrown when sms_messages.media_parts doesn't exist yet — i.e. this code
 * deployed ahead of migration 20260728140000. The caller degrades to plain-text
 * ingestion, so a message still lands and the pipeline still runs; only the
 * media half waits for the migration. It is a distinct type rather than a
 * boolean so the media path can never be entered half-configured.
 */
class MediaColumnMissingError extends Error {
  constructor() {
    super("sms_messages.media_parts is missing — run migration 20260728140000_sms_media.sql");
    this.name = "MediaColumnMissingError";
  }
}

function kindForMime(mime: string): NormalizedAttachment["kind"] {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "file";
}

function extForMime(mime: string, filename: string): string {
  const fromName = filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/gif": "gif",
    "audio/amr": "amr", "audio/3gpp": "3gp", "audio/mpeg": "mp3",
    "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav",
    "video/mp4": "mp4", "video/3gpp": "3gp",
    "application/pdf": "pdf", "text/plain": "txt",
  };
  return map[mime.toLowerCase().split(";")[0].trim()] ?? "bin";
}

/**
 * Decode the payload's attachment list. Anything without usable bytes is
 * dropped here rather than half-handled downstream. SMIL layout parts (every
 * MMS carries one) and the text/plain part — whose content is already the
 * message body — are not media and would otherwise be stored as junk files.
 */
function normalizeAttachments(payload: SmsReceivedPayload): NormalizedAttachment[] {
  // Both keys are CONCATENATED, not `attachments ?? parts`: an empty
  // `attachments: []` is not nullish, so the coalescing form silently ignored a
  // populated `parts` alongside it and dropped every attachment — while the
  // handoff doc promises the fork that either key is read.
  const raw = [
    ...(Array.isArray(payload.attachments) ? payload.attachments : []),
    ...(Array.isArray(payload.parts) ? payload.parts : []),
  ];
  const out: NormalizedAttachment[] = [];
  for (const [i, a] of raw.entries()) {
    // Bound the work a single webhook can create. Every part costs a Storage
    // upload; MAX_MEDIA_AI_PARTS caps only the paid analysis, so without this
    // a payload claiming 500 parts would still do 500 uploads.
    if (out.length >= MAX_MEDIA_STORED_PARTS) break;
    if (!a || typeof a !== "object") continue;
    const mime = String(a.contentType ?? a.mimeType ?? a.type ?? "").trim().toLowerCase();
    const b64 = String(a.data ?? a.base64 ?? a.content ?? "").trim();
    if (!b64) continue;
    if (mime.includes("smil") || mime.startsWith("text/")) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (buf.length === 0) continue;
    const filename = String(a.filename ?? a.name ?? "").trim() || `part${i}`;
    out.push({ buf, mime: mime || "application/octet-stream", filename, kind: kindForMime(mime) });
  }
  return out;
}

/**
 * Store one attachment in the private sms-media bucket. The object key is built
 * from the messageId (ASCII-safe) plus the part index — never from the sender's
 * filename, which can be Hebrew and which Supabase Storage rejects as an
 * invalid key (the bug that silently lost Hebrew-named WhatsApp documents).
 */
async function storeSmsAttachment(
  db: SupabaseAdmin,
  userId: string,
  messageId: string,
  index: number,
  att: NormalizedAttachment,
): Promise<StoredMediaPart> {
  const safeBase = messageId.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80);
  const path = `${userId}/${safeBase}-${index}.${extForMime(att.mime, att.filename)}`;
  const { error } = await db.storage.from("sms-media").upload(path, att.buf, {
    contentType: att.mime,
    upsert: true,
  });
  if (error) throw new Error(`sms-media upload: ${error.message}`);
  return {
    path,
    mime: att.mime,
    filename: att.filename,
    size: att.buf.length,
    kind: att.kind,
  };
}

/**
 * Has this exact messageId already been ingested WITH its media analysed? The
 * gateway redelivers a webhook it didn't get a fast enough 200 for, and
 * re-running Gemini on the same MMS is how a single WhatsApp voice note once
 * turned into five paid calls and tripped the rate limit for everything after
 * it. Returns the stored body + parts so the caller can reuse them wholesale.
 *
 * "Analysed" means the body carries real derived text: an OCR block, or a
 * transcript. Every failure path writes a bracketed placeholder ("[תמונה]"), so
 * a body that starts with "[" and has no [OCR] marker is a previous failure and
 * SHOULD be retried.
 *
 * A lookup error returns null, which means "analyse it again". That is
 * deliberately the EXPENSIVE answer rather than the safe-sounding one: reporting
 * "already done" on a failed read would leave the message with no text at all
 * and the picture invisible to the classifier for good. Losing money on a rare
 * repeat beats losing the content permanently.
 */
async function existingSmsMedia(
  db: SupabaseAdmin,
  userId: string,
  messageId: string,
): Promise<{ body: string; parts: StoredMediaPart[] } | null> {
  // media_parts arrives with migration 20260728140000; before it runs,
  // PostgREST rejects the whole select (42703/PGRST204) rather than ignoring the
  // unknown column. Falling through to "no prior media" here would then let the
  // upsert try to WRITE the column and 500 the webhook into a retry storm — each
  // retry re-billing the analysis — so detect it and say so.
  const { data, error } = await db
    .from("sms_messages")
    .select("body_text, media_parts")
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .maybeSingle();
  if (error) {
    if (/media_parts/.test(error.message)) {
      throw new MediaColumnMissingError();
    }
    console.error("[sms-webhook] existingSmsMedia lookup failed:", error.message);
    return null;
  }
  const parts = (data?.media_parts as StoredMediaPart[] | null) ?? null;
  if (!parts || parts.length === 0) return null;
  const body = String(data?.body_text ?? "").trim();
  const analysed = body.includes("[OCR]") || (body.length > 0 && !body.startsWith("["));
  return analysed ? { body, parts } : null;
}

/**
 * Turn an MMS's attachments into stored files plus the text the classifier will
 * read. Runs the SAME Gemini helpers as the WhatsApp webhook (@/lib/media/gemini)
 * — images get OCR, audio gets transcribed — so the two channels can't drift.
 *
 * The bytes are stored BEFORE the analysis, for the reason WhatsApp does it: a
 * Gemini outage must not cost the user the picture itself. A failure on one part
 * never loses the others or the message — the part gets an honest bracketed
 * placeholder and everything else proceeds.
 *
 * `analyse: false` (an OTP message) still stores every part. Withholding a photo
 * from the AI is not a reason to throw it away: a text like "the door code is
 * 4821" trips the OTP heuristic, and losing the attached picture would be
 * permanent.
 *
 * `derived` reports whether any REAL text came out. Every failure path here
 * writes a bracketed placeholder, and a body made only of those is not content —
 * the caller uses this to keep such a message out of the classifier instead of
 * handing it junk it would previously never have seen.
 */
async function processSmsAttachments(
  db: SupabaseAdmin,
  userId: string,
  messageId: string,
  caption: string,
  attachments: NormalizedAttachment[],
  analyse: boolean,
): Promise<{ body: string; parts: StoredMediaPart[]; derived: boolean }> {
  const parts: StoredMediaPart[] = [];
  const blocks: string[] = [];
  const deadline = Date.now() + MEDIA_ANALYSIS_BUDGET_MS;
  let derived = false;

  for (const [i, att] of attachments.entries()) {
    let stored = true;
    try {
      parts.push(await storeSmsAttachment(db, userId, messageId, i, att));
    } catch (e) {
      stored = false;
      console.error("[sms-webhook] attachment storage failed:", e);
    }
    // Never claim "נשמר" for a part whose upload threw — the user would go
    // looking in the reader for a file that isn't there.
    const kept = stored ? "נשמר" : "לא נשמר";

    if (!analyse) {
      blocks.push(`[קובץ מצורף ${i + 1} (${att.mime}) — ${kept}]`);
      continue;
    }
    if (i >= MAX_MEDIA_AI_PARTS) {
      blocks.push(`[קובץ מצורף ${i + 1} (${att.mime}) — ${kept}, לא נותח]`);
      continue;
    }
    if (Date.now() > deadline) {
      blocks.push(`[קובץ מצורף ${i + 1} (${att.mime}) — ${kept}, נגמר הזמן לניתוח]`);
      continue;
    }

    // Gemini's inline_data request is capped at ~20MB and base64 inflates by
    // ~33%, so anything past the ceiling cannot be analysed inline at all —
    // attempting it just burns money. The file is already stored above.
    if (att.buf.length > AUDIO_TRANSCRIBE_MAX_BYTES) {
      const mb = (att.buf.length / 1024 / 1024).toFixed(0);
      blocks.push(`[קובץ גדול (${mb}MB) — ${kept}, לא נותח אוטומטית]`);
      continue;
    }

    const b64 = att.buf.toString("base64");
    try {
      if (att.kind === "image") {
        const ocr = await performImageOcr(db, b64, att.mime, "gemini.sms");
        blocks.push(`[OCR]\n${ocr}`);
        derived = true;
      } else if (att.kind === "audio") {
        blocks.push(await transcribeAudio(db, b64, att.mime, "gemini.sms"));
        derived = true;
      } else if (att.kind === "video") {
        blocks.push(`[וידאו — ${kept}]`);
      } else {
        blocks.push(`[קובץ: ${att.filename} — ${kept}]`);
      }
    } catch (e) {
      console.warn("[sms-webhook] media analysis failed:", e);
      blocks.push(att.kind === "audio" ? "[אודיו - לא ניתן לתמלל כרגע]" : "[תמונה]");
    }
  }

  const body = [caption.trim() ? `כיתוב: ${caption.trim()}` : "", ...blocks]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return { body, parts, derived };
}

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
  return String(data?.timezone ?? "").trim() || "America/New_York";
}

/**
 * Assemble a rolling [INCOMING]/[OUTGOING] transcript for an SMS conversation —
 * the SMS twin of WhatsApp's refreshSourceMessageThread — so the AI classifier
 * sees the whole thread, not one isolated message. Writes ONE immutable
 * source_messages row PER message, keyed sms:<peer>:<messageId>, and stamps
 * metadata.chatId=<peer> (every downstream thread gate keys off chatId).
 *
 * It deliberately does NOT coalesce/supersede a burst into a single row: the
 * earlier design anchored on the *newest* message and marked every earlier
 * still-pending burst 'superseded', so a run of N messages from one peer
 * collapsed into ONE classification and the other N-1 were silently dropped
 * (the "lost 7 of 8" bug — previously fixed only for self-notes). ai-process
 * already routes follow-ups in the same chat into the existing task via
 * thread_key, so one row per message never spawns duplicate tasks, yet no
 * message is ever lost before it reaches the classifier.
 */
async function refreshSmsSourceThread(
  db: SupabaseAdmin,
  userId: string,
  peer: string,
  current: { messageId: string; direction: "incoming" | "outgoing"; body: string; receivedAt: string },
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

  // ONE immutable source_messages row PER message, keyed on THIS message's id
  // (not the burst's newest), so every distinct message reaches the classifier.
  // ignoreDuplicates makes a gateway re-delivery of the same messageId a no-op
  // instead of resetting a row the pipeline already classified/locked. No
  // supersede: ai-process routes same-chat follow-ups into the existing task
  // via thread_key, so per-message rows never duplicate a task, but nothing in
  // a burst is dropped. raw_content still carries the rolling transcript so the
  // classifier reads this message in the context of the whole conversation.
  const subject = current.direction === "incoming" ? `SMS מ-${peer}` : `SMS ל-${peer}`;
  const burstId = `sms:${peer}:${current.messageId}`;
  const bodyText = current.body.slice(0, 1000);
  const metadata = {
    chatId: peer,
    peerPhone: peer,
    direction: current.direction,
    lastDirection: current.direction,
    channel: "sms",
    messageId: current.messageId,
  };

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
      received_at: current.receivedAt,
      source_url: `sms:${peer}`,
      reply_to_context: peer,
      processing_status: "pending",
      ai_classification: null,
      metadata,
    },
    { onConflict: "user_id,source_type,source_id", ignoreDuplicates: true },
  );
  if (srcErr) throw new Error(`source_messages upsert: ${srcErr.message}`);
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
  event: string,
): Promise<IngestResult> {
  const direction: "incoming" | "outgoing" = isIncoming ? "incoming" : "outgoing";
  const rawMessageId = String(payload.messageId ?? "").trim();
  // `content://mms` and `content://sms` have independent `_id` sequences that
  // can overlap, so an MMS id can collide with an SMS row's id on the
  // (user_id, message_id) unique key. message_id is UNIQUE, so a collision is
  // not a duplicate row — it is a silent CLOBBER: the later message overwrites
  // the earlier one's body_text while its media_parts stay, leaving the reader
  // showing one message's caption beside another's photo, and existingSmsMedia's
  // "already analysed" test passing on the wrong text so the OCR is never
  // regenerated. Production hasn't hit it yet (ids observed from 4,112 to
  // 94,455,470 across 155 rows) precisely because the sequences are independent
  // — which is also why it is only a matter of time.
  //
  // So EVERY mms:* event is namespaced, not just mms:downloaded. `mmsdl:` is
  // kept for mms:downloaded so the rows already written under it stay
  // addressable. Cost of widening this: for a few minutes after deploy, an
  // in-flight redelivery of an mms:sent-observed message already stored under
  // its bare id lands as one extra row. That is a bounded one-off; the clobber
  // it prevents is silent and permanent.
  const messageId = !rawMessageId
    ? rawMessageId
    : event === "mms:downloaded"
      ? `mmsdl:${rawMessageId}`
      : event.startsWith("mms:")
        ? `mms:${rawMessageId}`
        : rawMessageId;
  // The conversation peer is the OTHER party: the sender for an incoming SMS,
  // the recipient for one we sent. `phoneNumber` is the deprecated fallback.
  const peer = String(
    (isIncoming ? payload.sender : payload.recipient) ?? payload.phoneNumber ?? "",
  ).trim();
  // MMS carries its text under `body` (mms:downloaded) or `text`/`subject`
  // rather than `message`. Prefer the actual message text over the subject.
  const body = String(payload.message ?? payload.text ?? payload.body ?? payload.subject ?? "");
  if (!messageId || !peer) {
    console.warn("[sms-webhook] payload missing messageId/peer, skipping");
    return { outcome: "skipped", reason: "missing_fields", direction, messageId, peer, bodyPreview: body };
  }

  const receivedAt = parseReceivedAt(payload.receivedAt ?? payload.sentAt);
  const simNumber =
    typeof payload.simNumber === "number" && Number.isFinite(payload.simNumber)
      ? payload.simNumber
      : null;
  // OTP detection runs on the TEXT the sender typed, never on OCR output — a
  // screenshot of a bank statement is not a one-time code. And it applies only
  // to INCOMING messages: an outgoing SMS the user wrote is never a code to
  // suppress.
  const isOtp = isIncoming ? looksLikeOtp(body) : false;

  // 1. MMS attachments → stored files + the text the classifier reads. Until
  //    2026-07-28 an MMS carrying nothing but a photo arrived with an empty
  //    body and was dropped at step 3 below, so the picture never existed as
  //    far as smrtesy was concerned. Now it is OCR'd (or transcribed) through
  //    the same Gemini module the WhatsApp webhook uses, and the derived text
  //    IS the body from here on — including in the rolling transcript that
  //    step 5 builds.
  //
  //    Attachments are stored even for an OTP message; only the paid analysis is
  //    withheld. "The door code is 4821" plus a photo trips the OTP heuristic,
  //    and dropping the photo over a false positive would be permanent.
  const attachments = normalizeAttachments(payload);
  let finalBody = body;
  let mediaParts: StoredMediaPart[] | null = null;
  let mediaDerivedText = false;
  if (attachments.length > 0) {
    try {
      // Redelivery guard, before any paid work: the gateway resends a webhook it
      // didn't get a fast 200 for, and re-analysing the same MMS is pure waste.
      const prior = await existingSmsMedia(db, userId, messageId);
      if (prior) {
        finalBody = prior.body;
        mediaParts = prior.parts;
        mediaDerivedText = true;
      } else {
        const processed = await processSmsAttachments(
          db, userId, messageId, body, attachments, !isOtp,
        );
        finalBody = processed.body || body;
        mediaParts = processed.parts.length > 0 ? processed.parts : null;
        mediaDerivedText = processed.derived;
      }
    } catch (e) {
      if (!(e instanceof MediaColumnMissingError)) throw e;
      // The migration hasn't run. Ingest the message as plain text rather than
      // failing the webhook — a 500 here would have the gateway redeliver on a
      // loop, and this path costs nothing to defer.
      console.warn(`[sms-webhook] ${e.message} — ingesting text only`);
      finalBody = body;
      mediaParts = null;
      mediaDerivedText = false;
    }
  }

  // 2. Durable record (idempotent on re-delivery). For outgoing SMS the "from"
  //    is the user's own line, which the gateway doesn't report, so we store a
  //    "me" sentinel (from_phone is NOT NULL) and key threads off the peer.
  //
  //    media_parts is spread in ONLY when there is media, so this write stays
  //    deploy-order independent: PostgREST rejects the WHOLE row with PGRST204
  //    ("could not find the column ... in the schema cache") if the column
  //    doesn't exist yet, which would take down every plain SMS as well the
  //    moment this code shipped ahead of migration 20260728140000. The media
  //    path itself can't reach here with a missing column — existingSmsMedia
  //    detects it above and degrades to text-only.
  const { error: smsErr } = await db.from("sms_messages").upsert(
    {
      user_id: userId,
      message_id: messageId,
      device_id: deviceId,
      direction: isIncoming ? "incoming" : "outgoing",
      from_phone: isIncoming ? peer : "me",
      to_phone: isIncoming ? (payload.recipient ?? null) : peer,
      sim_number: simNumber,
      body_text: finalBody,
      ...(mediaParts ? { media_parts: mediaParts } : {}),
      is_otp: isOtp,
      received_at: receivedAt,
      raw_payload: payloadForStorage(payload),
    },
    { onConflict: "user_id,message_id", ignoreDuplicates: false },
  );
  if (smsErr) throw new Error(`sms_messages upsert: ${smsErr.message}`);

  // 3. OTP / verification codes never reach the AI pipeline; empty bodies have
  //    nothing to classify. Both are still recorded in sms_messages above.
  if (isOtp) return { outcome: "ingested", reason: "otp_suppressed", direction, messageId, peer, bodyPreview: body };
  if (finalBody.trim().length === 0) return { outcome: "ingested", reason: "empty_body", direction, messageId, peer, bodyPreview: finalBody };
  //    A media message whose analysis produced nothing but placeholders
  //    ("[תמונה]", a Gemini outage) has no content either. Before attachments
  //    existed such a message was dropped here as empty; letting a placeholder
  //    through now would hand the classifier a task built from the word
  //    "[תמונה]" and nothing else. The file is stored and the row is written, so
  //    nothing is lost — a later look at /sms still shows the picture.
  if (!body.trim() && mediaParts && !mediaDerivedText) {
    return { outcome: "ingested", reason: "media_not_analysed", direction, messageId, peer, bodyPreview: finalBody };
  }

  // 4. Self-note: the user texting their OWN number as a task-capture channel —
  //    the SMS twin of WhatsApp self-chat. The device's own line is the
  //    `recipient` on any INCOMING sms; learn it once, cache it, then a message
  //    whose peer matches it is a deliberate self-note. These bypass the
  //    two-party thread builder (which would coalesce a burst and lose all but
  //    the newest) and get ONE immutable sms_echo row per message — each its own
  //    task, exactly like whatsapp_echo.
  const ownNumber = await resolveOwnNumber(db, userId, deviceId, isIncoming ? (payload.recipient ?? null) : null);
  const isSelfNote = !!ownNumber && numbersMatch(peer, ownNumber);
  if (isSelfNote) {
    await emitSmsSelfNote(db, userId, finalBody, receivedAt, ownNumber!);
    return { outcome: "ingested", reason: "self_note", direction, messageId, peer, bodyPreview: finalBody };
  }

  // 5. Build the rolling conversation transcript for this peer and write ONE
  //    source_messages row for THIS message (mirrors WhatsApp) so the classifier
  //    sees the whole thread — not this message in isolation — and can understand
  //    a reply like "Mistake, I didn't pay" in context. One row per message (no
  //    burst coalescing) so no message in a burst is ever dropped.
  await refreshSmsSourceThread(db, userId, peer, { messageId, direction, body: finalBody, receivedAt });

  return { outcome: "ingested", reason: null, direction, messageId, peer, bodyPreview: finalBody };
}

/**
 * The payload as we archive it in sms_messages.raw_payload — with attachment
 * BYTES stripped. Keeping them would store every photo twice (once in Storage,
 * once base64-inflated inside a jsonb column) and blow the row size up by
 * megabytes per MMS. The metadata is kept so a payload dispute is still
 * diagnosable from the archive alone.
 */
function payloadForStorage(payload: SmsReceivedPayload): Record<string, unknown> {
  // Test BOTH keys independently. `attachments ?? parts` returned the payload
  // verbatim whenever `attachments` was an empty array — which is not nullish —
  // so a populated `parts` alongside it went into the archive as raw base64:
  // megabytes per MMS, in the exact column this function exists to keep small.
  const hasAttachments = Array.isArray(payload.attachments) && payload.attachments.length > 0;
  const hasParts = Array.isArray(payload.parts) && payload.parts.length > 0;
  if (!hasAttachments && !hasParts) {
    return payload as unknown as Record<string, unknown>;
  }
  const describe = (a: SmsAttachmentPayload) => ({
    contentType: a.contentType ?? a.mimeType ?? a.type ?? null,
    filename: a.filename ?? a.name ?? null,
    base64_length: String(a.data ?? a.base64 ?? a.content ?? "").length,
  });
  const out: Record<string, unknown> = { ...(payload as unknown as Record<string, unknown>) };
  if (hasAttachments) out.attachments = payload.attachments!.map(describe);
  if (hasParts) out.parts = payload.parts!.map(describe);
  return out;
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
