/**
 * smrtBot — unofficial WhatsApp (Baileys) admin routes.
 *
 * Mounted under the smrtBot auth chain (requireAuth → requireOrg →
 * requireApp("smrtbot")); each route additionally requires per-bot access.
 * Drives the pairing lifecycle (connect / status / logout), the group sync,
 * and CRUD for the scheduled-broadcast queue that the cron drains.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireBotAccess } from "../require-bot-access";
import {
  startConnection,
  logoutConnection,
  syncGroups,
  liveStatus,
} from "../baileys";
import { resolveCreds, listTemplates } from "../wa";

const router = Router();

// ── WhatsApp message templates from Meta (for the smrtReach campaign picker) ──
router.get("/bot/bots/:botId/wa/templates", requireBotAccess(), async (req: Request, res: Response) => {
  const { data: bot, error } = await db
    .from("smrtbot_bots")
    .select("waba_id, wa_phone_number_id, wa_access_token, live_wa_phone_number_id, live_wa_access_token, test_wa_phone_number_id, test_wa_access_token")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  const wabaId = (bot as { waba_id?: string | null }).waba_id;
  if (!wabaId) return res.status(400).json({ error: "bot has no WABA id configured" });
  const creds = resolveCreds(bot as Parameters<typeof resolveCreds>[0], "live");
  if (!creds) return res.status(400).json({ error: "bot has no live WhatsApp credentials" });

  try {
    const templates = await listTemplates(wabaId, creds.accessToken);
    res.json({ templates });
  } catch (e) {
    res.status(502).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** Confirm the bot exists in this org and uses the Baileys transport. */
async function loadBaileysBot(req: Request, res: Response): Promise<boolean> {
  const { data: bot, error } = await db
    .from("smrtbot_bots")
    .select("id, transport")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return false;
  }
  if (!bot) {
    res.status(404).json({ error: "Bot not found" });
    return false;
  }
  if ((bot as { transport?: string }).transport !== "baileys") {
    res.status(400).json({ error: "bot is not on the unofficial (baileys) transport" });
    return false;
  }
  return true;
}

// ── connect: start the socket; QR appears in the session row ─────────────────
router.post("/bot/bots/:botId/wa/connect", requireBotAccess(), async (req: Request, res: Response) => {
  if (!(await loadBaileysBot(req, res))) return;
  await startConnection(req.org!.id, req.params.botId);
  const { data } = await db
    .from("smrtbot_wa_sessions")
    .select("status, last_qr, connected_phone, connected_at, last_error, updated_at")
    .eq("bot_id", req.params.botId)
    .maybeSingle();
  res.json({ session: data ?? { status: "connecting" } });
});

// ── status: poll connection state + latest QR ────────────────────────────────
router.get("/bot/bots/:botId/wa/status", requireBotAccess(), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_wa_sessions")
    .select("status, last_qr, connected_phone, connected_at, last_error, updated_at")
    .eq("bot_id", req.params.botId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ session: data ?? { status: "closed" }, live: liveStatus(req.params.botId) });
});

// ── logout: unlink the device + wipe creds ───────────────────────────────────
router.post("/bot/bots/:botId/wa/logout", requireBotAccess(), async (req: Request, res: Response) => {
  if (!(await loadBaileysBot(req, res))) return;
  await logoutConnection(req.org!.id, req.params.botId);
  res.json({ ok: true });
});

// ── groups: list synced groups/communities ───────────────────────────────────
router.get("/bot/bots/:botId/wa/groups", requireBotAccess(), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_wa_groups")
    .select("group_jid, subject, is_community, is_admin, participants_count, last_synced_at")
    .eq("org_id", req.org!.id)
    .eq("bot_id", req.params.botId)
    .order("subject");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ groups: data ?? [] });
});

// ── groups: re-sync from the live connection ─────────────────────────────────
router.post("/bot/bots/:botId/wa/groups/sync", requireBotAccess(), async (req: Request, res: Response) => {
  if (!(await loadBaileysBot(req, res))) return;
  try {
    const count = await syncGroups(req.params.botId);
    res.json({ ok: true, synced: count });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

// ── broadcasts: list ──────────────────────────────────────────────────────────
router.get("/bot/bots/:botId/broadcasts", requireBotAccess(), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_scheduled_broadcasts")
    .select("*")
    .eq("org_id", req.org!.id)
    .eq("bot_id", req.params.botId)
    .order("scheduled_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ broadcasts: data ?? [] });
});

// ── broadcasts: schedule a new one ───────────────────────────────────────────
router.post("/bot/bots/:botId/broadcasts", requireBotAccess(), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const targetJid = typeof body.target_jid === "string" ? body.target_jid.trim() : "";
  const targetType = body.target_type === "phone" ? "phone" : "group";
  const bodyText = typeof body.body_text === "string" ? body.body_text : "";
  const mediaUrl = typeof body.media_url === "string" && body.media_url.trim() ? body.media_url.trim() : null;
  const scheduledAt = typeof body.scheduled_at === "string" ? body.scheduled_at : "";

  if (!targetJid) return res.status(400).json({ error: "target_jid is required" });
  if (!bodyText.trim() && !mediaUrl) return res.status(400).json({ error: "body_text or media_url is required" });
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) return res.status(400).json({ error: "scheduled_at must be a valid date" });

  const { data, error } = await db
    .from("smrtbot_scheduled_broadcasts")
    .insert({
      org_id: req.org!.id,
      bot_id: req.params.botId,
      target_type: targetType,
      target_jid: targetJid,
      body_text: bodyText,
      media_url: mediaUrl,
      scheduled_at: when.toISOString(),
      source: "manual",
      created_by: req.user!.id,
    })
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ broadcast: data });
});

// ── broadcasts: edit or cancel a pending one ─────────────────────────────────
router.patch("/bot/bots/:botId/broadcasts/:id", requireBotAccess(), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof body.body_text === "string") updates.body_text = body.body_text;
  if (typeof body.media_url === "string") updates.media_url = body.media_url.trim() || null;
  if (typeof body.target_jid === "string" && body.target_jid.trim()) updates.target_jid = body.target_jid.trim();
  if (typeof body.scheduled_at === "string") {
    const when = new Date(body.scheduled_at);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: "scheduled_at must be a valid date" });
    updates.scheduled_at = when.toISOString();
  }
  if (body.status === "canceled") updates.status = "canceled";
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "No updatable fields provided" });

  // Only pending rows may be changed (already-sent broadcasts are immutable).
  const { data, error } = await db
    .from("smrtbot_scheduled_broadcasts")
    .update(updates)
    .eq("org_id", req.org!.id)
    .eq("bot_id", req.params.botId)
    .eq("id", req.params.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Pending broadcast not found" });
  res.json({ broadcast: data });
});

// ── broadcasts: delete ────────────────────────────────────────────────────────
router.delete("/bot/bots/:botId/broadcasts/:id", requireBotAccess(), async (req: Request, res: Response) => {
  const { error } = await db
    .from("smrtbot_scheduled_broadcasts")
    .delete()
    .eq("org_id", req.org!.id)
    .eq("bot_id", req.params.botId)
    .eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

export default router;
