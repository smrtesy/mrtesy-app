/**
 * smrtBot — bot management routes (admin "Bots" screen backend).
 *
 * Mounted under the smrtBot auth chain (requireAuth → requireOrg →
 * requireApp("smrtbot")). Creating bots and managing access require
 * owner/admin; viewing/editing a bot requires per-bot access (ב3).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { randomBytes } from "crypto";

import { db } from "../../../db";
import { requireRole } from "../../../middleware";
import { emitEvent, notifyError } from "../../../lib/platform";
import { requireBotAccess } from "../require-bot-access";

const router = Router();

/** Public, globally-unique, rotatable embed key for the web-chat widget. */
function generateWebKey(): string {
  return `wk_${randomBytes(12).toString("hex")}`;
}

/** Write-or-rotate a Vault secret; returns the (possibly new) secret id. */
async function upsertVaultSecret(
  newValue: string,
  existingId: string | null,
  name: string,
  description: string,
): Promise<{ id: string | null; error: string | null }> {
  if (existingId) {
    const { error } = await db.rpc("vault_update_secret", { secret_id: existingId, new_secret: newValue });
    if (error) return { id: null, error: error.message };
    return { id: existingId, error: null };
  }
  const { data, error } = await db.rpc("vault_create_secret", {
    new_secret: newValue,
    new_name: name,
    new_description: description,
  });
  if (error) return { id: null, error: error.message };
  return { id: (data as string | null) ?? null, error: null };
}

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
  "transport",
  "wa_phone_number_id",
  "wa_access_token",
  "verify_token",
  "app_secret",
  "test_wa_phone_number_id",
  "test_wa_access_token",
  "test_verify_token",
  "test_phone_display",
  "live_wa_phone_number_id",
  "live_wa_access_token",
  "live_verify_token",
  "live_phone_display",
  // web-chat channel
  "web_enabled",
  "web_env",
  "web_allowed_origins",
  "web_greeting",
  "web_accent_color",
  "web_icon_url",
  "web_title",
  "web_subtitle",
  "web_position",
  "web_size",
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
  // Org slug lets the client build the preferred (globally-unique) webhook
  // callback URL "<org_slug>_<bot_slug>".
  const { data: org } = await db
    .from("organizations")
    .select("slug")
    .eq("id", req.org!.id)
    .maybeSingle();
  // Never ship the legacy plaintext App Secret to the client — it's write-only
  // now (per-env values live in Vault, exposed only as *_app_secret_id pointers).
  const { app_secret: _omitAppSecret, ...safe } = data as Record<string, unknown>;
  res.json({ bot: { ...safe, org_slug: (org?.slug as string | null) ?? null } });
});

/** PUT /bot/bots/:botId/app-secret { env: 'live'|'test', value } — store a
 *  per-env Meta App Secret in Vault (encrypted) and keep only its pointer on
 *  the bot. Write-only: the plaintext is never returned. */
router.put("/bot/bots/:botId/app-secret", requireBotAccess(), async (req: Request, res: Response) => {
  const env = req.body?.env === "test" ? "test" : req.body?.env === "live" ? "live" : null;
  const value = req.body?.value;
  if (!env) return res.status(400).json({ error: "env must be 'live' or 'test'" });
  if (typeof value !== "string" || !value.trim()) return res.status(400).json({ error: "value is required" });

  const col = env === "live" ? "live_app_secret_id" : "test_app_secret_id";
  const { data: bot, error: botErr } = await db
    .from("smrtbot_bots")
    .select("id, live_app_secret_id, test_app_secret_id")
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId)
    .maybeSingle();
  if (botErr) return res.status(500).json({ error: botErr.message });
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  const existingId = (bot[col] as string | null) ?? null;
  const { id, error } = await upsertVaultSecret(
    value.trim(),
    existingId,
    `smrtbot_${req.params.botId}_${env}_app_secret`,
    `smrtBot ${env} App Secret`,
  );
  if (error || !id) return res.status(500).json({ error: error ?? "vault error" });

  const { error: updErr } = await db
    .from("smrtbot_bots")
    .update({ [col]: id })
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId);
  if (updErr) return res.status(500).json({ error: updErr.message });
  res.json({ ok: true });
});

// ── Update bot basic details + credentials ───────────────────
router.patch("/bot/bots/:botId", requireBotAccess(), async (req: Request, res: Response) => {
  const updates = pickUpdatable((req.body ?? {}) as Record<string, unknown>);
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "No updatable fields provided" });
  }

  // web_position / web_size are NOT NULL with defaults — never write null/empty.
  for (const k of ["web_position", "web_size"] as const) {
    if (k in updates && !updates[k]) delete updates[k];
  }

  // Mint a public embed key the first time web chat is enabled, so the admin
  // UI always has a key to build the snippet from.
  if (updates.web_enabled === true) {
    const { data: current } = await db
      .from("smrtbot_bots")
      .select("web_key")
      .eq("org_id", req.org!.id)
      .eq("id", req.params.botId)
      .maybeSingle();
    if (!current?.web_key) updates.web_key = generateWebKey();
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

// ── Rotate the public web embed key ──────────────────────────
router.post("/bot/bots/:botId/web-key", requireBotAccess(), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_bots")
    .update({ web_key: generateWebKey() })
    .eq("org_id", req.org!.id)
    .eq("id", req.params.botId)
    .select("web_key")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ web_key: data.web_key });
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
