/**
 * smrtBot — bot management routes (admin "Bots" screen backend).
 *
 * Mounted under the smrtBot auth chain (requireAuth → requireOrg →
 * requireApp("smrtbot")). Creating bots and managing access require
 * owner/admin; viewing/editing a bot requires per-bot access (ב3).
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireRole } from "../../../middleware";
import { emitEvent, notifyError } from "../../../lib/platform";
import { requireBotAccess } from "../require-bot-access";

const router = Router();

// Fields a client may set when creating/updating a bot.
const BOT_UPDATABLE = new Set([
  "name",
  "slug",
  "initials",
  "logo_path",
  "public_phone_number",
  "waba_id",
  "email_footer_text",
  "admin_phones",
  "timezone",
  "active",
  "wa_phone_number_id",
  "wa_access_token",
  "verify_token",
  "test_wa_phone_number_id",
  "test_wa_access_token",
  "test_verify_token",
  "test_phone_display",
  "live_wa_phone_number_id",
  "live_wa_access_token",
  "live_verify_token",
  "live_phone_display",
]);

function pickUpdatable(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (BOT_UPDATABLE.has(k)) out[k] = v;
  }
  return out;
}

// ── List bots the caller can see ─────────────────────────────
router.get("/bot/bots", async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const isManager = req.member!.role === "owner" || req.member!.role === "admin";

  let query = db.from("smrtbot_bots").select("*").eq("org_id", orgId).order("name");

  if (!isManager) {
    // Members see only bots they have an access row for.
    const { data: access, error: accessErr } = await db
      .from("smrtbot_bot_access")
      .select("bot_id")
      .eq("org_id", orgId)
      .eq("user_id", req.member!.user_id);
    if (accessErr) return res.status(500).json({ error: accessErr.message });
    const ids = (access ?? []).map((r) => r.bot_id as string);
    if (ids.length === 0) return res.json({ bots: [] });
    query = query.in("id", ids);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ bots: data ?? [] });
});

// ── Create a bot (managers only) ─────────────────────────────
router.post("/bot/bots", requireRole("owner", "admin"), async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const slug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(slug)) {
    return res.status(400).json({ error: "slug must be lowercase letters/digits/hyphens" });
  }

  const insert = {
    ...pickUpdatable(body),
    name,
    slug,
    org_id: req.org!.id,
    created_by: req.user!.id,
  };

  const { data, error } = await db.from("smrtbot_bots").insert(insert).select("*").single();
  if (error) {
    await notifyError(req.org!.id, "smrtbot", {
      title: "Failed to create bot",
      body: error.message,
    });
    return res.status(500).json({ error: error.message });
  }

  await emitEvent(req.org!.id, "smrtbot", "bot.created", "bot", data.id, { name: data.name });
  res.status(201).json({ bot: data });
});

// ── Get one bot ──────────────────────────────────────────────
router.get("/bot/bots/:botId", requireBotAccess(), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_bots")
    .select("*")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Bot not found" });
  res.json({ bot: data });
});

// ── Update bot basic details + credentials ───────────────────
router.patch("/bot/bots/:botId", requireBotAccess(), async (req: Request, res: Response) => {
  const updates = pickUpdatable((req.body ?? {}) as Record<string, unknown>);
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  const { data, error } = await db
    .from("smrtbot_bots")
    .update(updates)
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId)
    .select("*")
    .single();
  if (error) {
    await notifyError(req.org!.id, "smrtbot", {
      title: "Failed to update bot",
      body: error.message,
    });
    return res.status(500).json({ error: error.message });
  }
  res.json({ bot: data });
});

// ── Access management (managers only) ────────────────────────
router.get(
  "/bot/bots/:botId/access",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { data, error } = await db
      .from("smrtbot_bot_access")
      .select("id, user_id, created_at")
      .eq("org_id", req.org!.id)
      .eq("bot_id", req.params.botId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ access: data ?? [] });
  },
);

router.post(
  "/bot/bots/:botId/access",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const userId = typeof req.body?.user_id === "string" ? req.body.user_id : "";
    if (!userId) return res.status(400).json({ error: "user_id is required" });

    const { data, error } = await db
      .from("smrtbot_bot_access")
      .upsert(
        {
          org_id: req.org!.id,
          bot_id: req.params.botId,
          user_id: userId,
          created_by: req.user!.id,
        },
        { onConflict: "bot_id,user_id" },
      )
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.status(201).json({ access: data });
  },
);

router.delete(
  "/bot/bots/:botId/access/:userId",
  requireRole("owner", "admin"),
  async (req: Request, res: Response) => {
    const { error } = await db
      .from("smrtbot_bot_access")
      .delete()
      .eq("org_id", req.org!.id)
      .eq("bot_id", req.params.botId)
      .eq("user_id", req.params.userId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  },
);

export default router;
