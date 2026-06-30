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
