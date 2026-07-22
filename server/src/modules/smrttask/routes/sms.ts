/**
 * SMS device connection API for smrtTask.
 *
 * Lets a user register the "SMS Gateway for Android" app running on their own
 * phone (local / self-hosted mode) so its received-SMS webhook is trusted and
 * routed to their account. The inbound webhook itself lives on the Next.js
 * side (src/app/api/webhooks/sms/route.ts); these endpoints only manage the
 * deviceId → user_id mapping and the per-device HMAC signing key (stored in
 * Vault, never returned again after creation).
 *
 *   GET  /sms/connections      list the caller's registered devices (no keys)
 *   POST /sms/connect          register/rotate a device, returns webhook URL + key
 *   POST /sms/disconnect       deactivate a device by id
 *
 * All routes gated through the standard smrtTask auth chain and scoped to the
 * caller via sms_connections.user_id.
 */

import crypto from "node:crypto";
import { Router, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireFullTask } from "../lib/access";

const router = Router();
const gate = [requireAuth, requireOrg, requireApp("smrttask"), requireFullTask];

/** Canonical public app URL (FRONTEND_URL may be a comma-separated CORS list). */
function appBaseUrl(): string {
  return (process.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0].trim().replace(/\/+$/, "");
}

/**
 * Canonical key for grouping/matching phone numbers the SMS gateway stores in
 * inconsistent formats — "+14083757770", "14083757770" and "4083757770" are one
 * line, and left un-normalized they split into separate threads so a
 * conversation shows only half its messages. Digits only; for a real phone
 * number (≥10 digits) we key on the last 10 so a leading country code never
 * splits a thread. Short codes (<10 digits) key on their full digits. Mirrors
 * the webhook's numbersMatch heuristic.
 */
function normPhone(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.length >= 10 ? d.slice(-10) : d;
}

/**
 * The set of literal formats a peer might be stored under, so a conversation
 * query catches every variant. Used as an indexed IN-list — a strict superset
 * of the old exact match, so it can only ADD a conversation's messages, never
 * drop one. Covers the observed formats: the raw string, digits only,
 * "+digits", and the US country-code pair (the 10-digit national number and its
 * "1"/"+1"-prefixed forms).
 */
function phoneVariants(peer: string): string[] {
  const raw = peer.trim();
  const d = raw.replace(/\D/g, "");
  const out = new Set<string>();
  if (raw) out.add(raw);
  if (d) {
    out.add(d);
    out.add(`+${d}`);
  }
  const national = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (national.length === 10) {
    out.add(national);
    out.add(`+${national}`);
    out.add(`1${national}`);
    out.add(`+1${national}`);
  }
  // Guard against PostgREST in()-list breakers. Phone variants are digits/"+"
  // only, but strip anything exotic defensively before it reaches the filter.
  return [...out].map((v) => v.replace(/[,()*\\ ]/g, "")).filter(Boolean);
}

/**
 * Which of two format variants of the same line to show as the thread's peer.
 * Prefer an E.164-looking "+" form, then the more complete (longer) string.
 */
function preferPeerDisplay(candidate: string, current: string): boolean {
  const cPlus = candidate.startsWith("+");
  const curPlus = current.startsWith("+");
  if (cPlus !== curPlus) return cPlus;
  return candidate.length > current.length;
}

// ── List registered devices ────────────────────────────────────────────────
router.get("/sms/connections", ...gate, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("sms_connections")
    .select("id, device_id, label, display_phone_number, connected_at, disconnected_at")
    .eq("user_id", req.user!.id)
    .order("connected_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ connections: data ?? [], webhook_url: `${appBaseUrl()}/api/webhooks/sms` });
});

// ── Register or rotate a device ──────────────────────────────────────────────
// Body: { deviceId: string, label?: string, phoneNumber?: string }
// Returns: { ok, webhook_url, signing_key, device_id }
// The signing key is generated here and returned ONCE — the user pastes it
// into the app's Settings → Webhooks → Signing Key. We persist only the Vault
// pointer, so the key is never readable again from our side.
router.post("/sms/connect", ...gate, async (req: Request, res: Response) => {
  const { deviceId, label, phoneNumber } = (req.body ?? {}) as {
    deviceId?: string;
    label?: string;
    phoneNumber?: string;
  };

  const device = String(deviceId ?? "").trim();
  if (!device) return res.status(400).json({ error: "deviceId is required" });
  if (device.length > 200) return res.status(400).json({ error: "deviceId too long" });

  // device_id is globally UNIQUE — block hijacking another user's device.
  const { data: existing, error: existErr } = await db
    .from("sms_connections")
    .select("id, user_id, signing_key_id")
    .eq("device_id", device)
    .maybeSingle();
  if (existErr) return res.status(500).json({ error: existErr.message });
  if (existing && existing.user_id !== req.user!.id) {
    return res.status(409).json({ error: "device_in_use" });
  }

  // Fresh signing key on every connect/rotate.
  const signingKey = crypto.randomBytes(32).toString("hex");
  // SHA-256 of the key lets the webhook auto-heal a reinstalled device via a
  // single indexed lookup instead of scanning every connection's Vault secret.
  const signingKeySha256 = crypto.createHash("sha256").update(signingKey).digest("hex");
  const { data: secretId, error: vaultErr } = await db.rpc("vault_create_secret", {
    new_secret: signingKey,
    new_name: `sms_signing_key:${req.user!.id}:${device}:${Date.now()}`,
    new_description: `SMS Gateway HMAC signing key for device ${device}`,
  });
  if (vaultErr || typeof secretId !== "string") {
    return res.status(500).json({ error: `vault: ${vaultErr?.message ?? "no_secret_id"}` });
  }

  const nowIso = new Date().toISOString();
  const trimmedLabel = typeof label === "string" ? label.trim().slice(0, 120) || null : null;
  const trimmedPhone = typeof phoneNumber === "string" ? phoneNumber.trim().slice(0, 40) || null : null;

  const { error: upsertErr } = await db.from("sms_connections").upsert(
    {
      user_id: req.user!.id,
      device_id: device,
      label: trimmedLabel,
      display_phone_number: trimmedPhone,
      signing_key_id: secretId,
      signing_key_sha256: signingKeySha256,
      connected_at: nowIso,
      disconnected_at: null,
    },
    { onConflict: "device_id" },
  );
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  // The token rides inside the webhook URL: the Android app forwards a stored
  // URL verbatim and (in current builds) has no UI to share its own HMAC key
  // with us, so a secret URL token is the practical proof of authenticity.
  const webhookUrl = `${appBaseUrl()}/api/webhooks/sms?token=${encodeURIComponent(signingKey)}`;
  return res.json({
    ok: true,
    webhook_url: webhookUrl,
    signing_key: signingKey,
    device_id: device,
  });
});

// ── Conversation list ────────────────────────────────────────────────────────
// One row per conversation peer (the other party), newest first. Mirrors the
// WhatsApp threads endpoint: pull a recent window and aggregate in JS. The peer
// is the sender on incoming rows and the recipient on outgoing rows (outgoing
// from_phone is the "me" sentinel, so it is never a peer).
router.get("/sms/threads", ...gate, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "500"), 10) || 500, 2000);
  const { data, error } = await db
    .from("sms_messages")
    .select("direction, from_phone, to_phone, body_text, is_otp, received_at")
    .eq("user_id", req.user!.id)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Tasks created from SMS, grouped by the NORMALIZED peer stored in metadata
  // (so format variants of the same line share one count, matching the thread
  // grouping below).
  const { data: taskRows, error: taskErr } = await db
    .from("tasks")
    .select("id, source_messages!inner(source_type, user_id, metadata)")
    .eq("source_messages.source_type", "sms")
    .eq("source_messages.user_id", req.user!.id)
    .neq("status", "archived")
    .limit(2000);
  if (taskErr) console.warn("[sms] threads task-count query:", taskErr.message);
  const tasksByKey = new Map<string, number>();
  for (const t of taskRows ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sm = (t as any).source_messages;
    const row = Array.isArray(sm) ? sm[0] : sm;
    const key = normPhone(row?.metadata?.peerPhone as string | undefined);
    if (!key) continue;
    tasksByKey.set(key, (tasksByKey.get(key) ?? 0) + 1);
  }

  type Row = NonNullable<typeof data>[number];
  const peerOf = (m: Row) => (m.direction === "incoming" ? m.from_phone : m.to_phone);
  // Group by the normalized number so the same line stored under two formats
  // ("+1408…" and "1408…") is ONE conversation, not two half-empty ones. Rows
  // arrive newest-first, so the first row seen per key is the latest message;
  // we still surface a friendly display peer, preferring the E.164 "+" form.
  const groups = new Map<string, { latest: Row; display: string }>();
  for (const row of data ?? []) {
    const peer = peerOf(row);
    if (!peer || peer === "me") continue;
    const key = normPhone(peer);
    if (!key) continue;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { latest: row, display: peer });
    } else if (preferPeerDisplay(peer, existing.display)) {
      existing.display = peer;
    }
  }
  const threads = [...groups.entries()]
    .map(([key, g]) => ({
      peer: g.display,
      last_message_at: g.latest.received_at,
      last_direction: g.latest.direction,
      last_body_text: g.latest.body_text,
      task_count: tasksByKey.get(key) ?? 0,
    }))
    .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
  return res.json({ threads });
});

// ── Messages within a conversation ───────────────────────────────────────────
// GET /sms/messages?peer=<phone>  → chronological (oldest→newest), read-only.
router.get("/sms/messages", ...gate, async (req: Request, res: Response) => {
  const peer = String(req.query.peer ?? "").trim();
  if (!peer) return res.status(400).json({ error: "peer is required" });
  const limit = Math.min(parseInt(String(req.query.limit ?? "300"), 10) || 300, 1000);

  // Match EVERY format the peer might be stored under, not just the one the
  // caller passed — otherwise a line saved as both "+1408…" and "1408…" shows
  // only the half that matches verbatim (the reported "I don't see all the
  // messages from him"). The variant IN-list is a superset of the old exact
  // match, so it can only add this conversation's messages.
  const variants = phoneVariants(peer);
  if (variants.length === 0) return res.json({ messages: [], tasks: [] });
  const inList = variants.join(",");

  const { data, error } = await db
    .from("sms_messages")
    .select("id, message_id, direction, from_phone, to_phone, body_text, is_otp, received_at")
    .eq("user_id", req.user!.id)
    .or(`from_phone.in.(${inList}),to_phone.in.(${inList})`)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Tasks created from this peer's messages (badge in the UI). Matched on the
  // normalized number in JS so format variants aren't under-counted. Fetched
  // newest-first so the 2000-row cap keeps a peer's most RECENT tasks (a user
  // with more than that many SMS tasks would otherwise lose the newest ones);
  // the filtered result is re-sorted back to ascending for the caller.
  const key = normPhone(peer);
  const { data: taskRows, error: taskErr } = await db
    .from("tasks")
    .select("id, title, title_he, status, created_at, source_messages!inner(source_type, user_id, metadata)")
    .eq("source_messages.source_type", "sms")
    .eq("source_messages.user_id", req.user!.id)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (taskErr) console.warn("[sms] messages task-count query:", taskErr.message);

  const tasks = (taskRows ?? [])
    .filter((t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sm = (t as any).source_messages;
      const row = Array.isArray(sm) ? sm[0] : sm;
      return normPhone(row?.metadata?.peerPhone as string | undefined) === key;
    })
    .map((t) => ({
      id: t.id,
      title: t.title,
      title_he: t.title_he,
      status: t.status,
      created_at: t.created_at,
    }))
    .reverse();

  return res.json({ messages: [...(data ?? [])].reverse(), tasks });
});

// ── Search inside message content ────────────────────────────────────────────
// GET /sms/search?q=<term>&limit=  → the set of conversation peers whose message
// body matches the term, each with the newest matching snippet. Numbers are
// matched client-side over the already-loaded thread list; this endpoint covers
// the "search inside messages" half. Scoped to the caller via user_id. Mirrors
// the WhatsApp search endpoint.
router.get("/sms/search", ...gate, async (req: Request, res: Response) => {
  const raw = String(req.query.q ?? "").trim();
  if (raw.length < 2) return res.json({ results: [] });
  const limit = Math.min(parseInt(String(req.query.limit ?? "300"), 10) || 300, 1000);

  // Strip PostgREST or()/ilike metacharacters so user input can't break the
  // filter or smuggle in wildcards; '%' then wraps the term as a substring.
  const term = raw.replace(/[%_*(),\\]/g, " ").trim();
  if (!term) return res.json({ results: [] });
  const pattern = `%${term}%`;

  const { data, error } = await db
    .from("sms_messages")
    .select("direction, from_phone, to_phone, body_text, received_at")
    .eq("user_id", req.user!.id)
    .ilike("body_text", pattern)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Newest matching snippet per NORMALIZED peer (same grouping as /sms/threads),
  // so a match lines up with exactly one conversation row in the UI.
  const byKey = new Map<string, { peer: string; snippet: string }>();
  for (const row of data ?? []) {
    const peer = row.direction === "incoming" ? row.from_phone : row.to_phone;
    if (!peer || peer === "me") continue;
    const key = normPhone(peer);
    if (!key || byKey.has(key)) continue;
    byKey.set(key, { peer, snippet: (row.body_text ?? "").slice(0, 160) });
  }
  return res.json({ results: [...byKey.values()] });
});

// ── Webhook diagnostic log ────────────────────────────────────────────────
// GET /sms/webhook-log  → the most recent inbound webhook hits + their outcome
// (ingested / ignored / dropped + reason), so the user can see exactly what
// their phone's SMS Gateway is delivering. Includes rows we dropped before
// resolving the account (e.g. unknown_device / bad_token) as long as the hit
// carried one of the caller's registered device ids.
router.get("/sms/webhook-log", ...gate, async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

  // The caller's device ids, so device-scoped drops with no resolved user_id
  // (unknown_device / bad_token) still surface in their own log.
  const { data: conns } = await db
    .from("sms_connections")
    .select("device_id")
    .eq("user_id", req.user!.id);
  // Guard against PostgREST in()-list breakers; device ids are hex-like.
  const deviceIds = (conns ?? [])
    .map((c) => String(c.device_id ?? "").replace(/[,()*\\ ]/g, ""))
    .filter((d) => d.length > 0);

  const filter =
    deviceIds.length > 0
      ? `user_id.eq.${req.user!.id},device_id.in.(${deviceIds.join(",")})`
      : `user_id.eq.${req.user!.id}`;

  const { data, error } = await db
    .from("sms_webhook_debug")
    .select("id, created_at, event, direction, outcome, reason, message_id, peer, body_preview, device_id")
    .or(filter)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ log: data ?? [] });
});

// ── Deactivate a device ──────────────────────────────────────────────────────
// Body: { id: string }  (sms_connections.id)
router.post("/sms/disconnect", ...gate, async (req: Request, res: Response) => {
  const { id } = (req.body ?? {}) as { id?: string };
  if (!id || typeof id !== "string") return res.status(400).json({ error: "id is required" });

  const { error } = await db
    .from("sms_connections")
    .update({ disconnected_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", req.user!.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

export default router;
