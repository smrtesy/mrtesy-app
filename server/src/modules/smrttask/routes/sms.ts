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

const router = Router();
const gate = [requireAuth, requireOrg, requireApp("smrttask")];

/** Canonical public app URL (FRONTEND_URL may be a comma-separated CORS list). */
function appBaseUrl(): string {
  return (process.env.FRONTEND_URL ?? "http://localhost:3000").split(",")[0].trim().replace(/\/+$/, "");
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

  // Tasks created from SMS, grouped by the peer stored in metadata.
  const { data: taskRows } = await db
    .from("tasks")
    .select("id, source_messages!inner(source_type, user_id, metadata)")
    .eq("source_messages.source_type", "sms")
    .eq("source_messages.user_id", req.user!.id)
    .neq("status", "archived")
    .limit(2000);
  const tasksByPeer = new Map<string, number>();
  for (const t of taskRows ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sm = (t as any).source_messages;
    const row = Array.isArray(sm) ? sm[0] : sm;
    const peer = (row?.metadata?.peerPhone as string | undefined) ?? undefined;
    if (!peer) continue;
    tasksByPeer.set(peer, (tasksByPeer.get(peer) ?? 0) + 1);
  }

  type Row = NonNullable<typeof data>[number];
  const peerOf = (m: Row) => (m.direction === "incoming" ? m.from_phone : m.to_phone);
  const latest = new Map<string, Row>();
  for (const row of data ?? []) {
    const peer = peerOf(row);
    if (!peer || peer === "me") continue;
    if (!latest.has(peer)) latest.set(peer, row);
  }
  const threads = [...latest.entries()].map(([peer, m]) => ({
    peer,
    last_message_at: m.received_at,
    last_direction: m.direction,
    last_body_text: m.body_text,
    task_count: tasksByPeer.get(peer) ?? 0,
  }));
  return res.json({ threads });
});

// ── Messages within a conversation ───────────────────────────────────────────
// GET /sms/messages?peer=<phone>  → chronological (oldest→newest), read-only.
router.get("/sms/messages", ...gate, async (req: Request, res: Response) => {
  const peer = String(req.query.peer ?? "").trim();
  if (!peer) return res.status(400).json({ error: "peer is required" });
  // Strip PostgREST or()-delimiter characters so the filter can't be broken.
  const safePeer = peer.replace(/[,()*\\]/g, "");
  const limit = Math.min(parseInt(String(req.query.limit ?? "300"), 10) || 300, 1000);

  const { data, error } = await db
    .from("sms_messages")
    .select("id, message_id, direction, from_phone, to_phone, body_text, is_otp, received_at")
    .eq("user_id", req.user!.id)
    .or(`from_phone.eq.${safePeer},to_phone.eq.${safePeer}`)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  // Tasks created from this peer's messages (badge in the UI).
  const { data: taskRows } = await db
    .from("tasks")
    .select("id, title, title_he, status, created_at, source_messages!inner(source_type, user_id, metadata)")
    .eq("source_messages.source_type", "sms")
    .eq("source_messages.user_id", req.user!.id)
    // Parameterized eq (not an or() filter), so match the RAW peer — peerPhone
    // is stored verbatim in metadata; using the sanitized form could under-count.
    .eq("source_messages.metadata->>peerPhone", peer)
    .order("created_at", { ascending: true })
    .limit(500);

  const tasks = (taskRows ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    title_he: t.title_he,
    status: t.status,
    created_at: t.created_at,
  }));

  return res.json({ messages: [...(data ?? [])].reverse(), tasks });
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
