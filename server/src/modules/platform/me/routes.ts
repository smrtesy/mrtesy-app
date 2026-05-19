/**
 * Per-user routes (no org context needed).
 *
 *   GET    /me/settings        the caller's user_settings row
 *   PATCH  /me/settings        update whitelisted fields
 *   GET    /me/credentials     list which services this user has connected (no tokens leaked)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, isSuperAdmin } from "../../../middleware";
import { getOAuthClient } from "../../../services/token-refresh";

const router = Router();

const UPDATABLE_SETTINGS = new Set([
  "display_name", "timezone", "office_addresses", "skip_senders",
  "skip_recipients", "my_emails", "drive_folder_id",
  "calendar_event_filter", "calendar_allday_tasks", "calendar_holidays_tasks",
  "classification_model", "summary_model", "daily_ai_budget_usd",
  "show_ai_costs", "reminder_channels", "default_reminder_timing",
  "preferred_language", "ai_clarification_prefs",
  "initial_scan_days_back", "calendar_initial_scan_months",
  "onboarding_completed", "initial_setup_completed",
  // The /api/auth/google/callback writes these — allow PATCH for completeness
  "gmail_connected", "drive_connected", "whatsapp_connected", "calendar_connected",
]);

function pick(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (UPDATABLE_SETTINGS.has(k)) out[k] = body[k];
  return out;
}

/** GET /me/settings */
router.get("/me/settings", requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("user_settings")
    .select("*")
    .eq("user_id", req.user!.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ settings: data });
});

/** PATCH /me/settings — upsert */
router.patch("/me/settings", requireAuth, async (req: Request, res: Response) => {
  const updates = pick(req.body ?? {});
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  // Upsert: most users have a settings row from signup, but be defensive
  const { data: existing } = await db
    .from("user_settings")
    .select("id")
    .eq("user_id", req.user!.id)
    .maybeSingle();

  if (existing) {
    const { data, error } = await db
      .from("user_settings")
      .update(updates)
      .eq("user_id", req.user!.id)
      .select("*")
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ settings: data });
  }

  const { data, error } = await db
    .from("user_settings")
    .insert({ user_id: req.user!.id, ...updates })
    .select("*")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ settings: data });
});

/** GET /me/super-admin — am I a super-admin? Used by frontend to gate the Admin UI. */
router.get("/me/super-admin", requireAuth, async (req: Request, res: Response) => {
  const ok = await isSuperAdmin(req.user!);
  res.json({ is_super_admin: ok });
});

/**
 * POST /me/whatsapp/connect — bind the caller's smrtTask user to a Meta
 * WhatsApp phone number (the IDs visible in their DualHook dashboard) and
 * stash their Meta Cloud API Access Token in Supabase Vault.
 *
 * This is how the inbound webhook routes events to the right user:
 * incoming Meta payloads carry `metadata.phone_number_id`, we look it up
 * in `whatsapp_connections`, and that gives us the smrtTask user_id plus
 * a vault pointer for the access token used to fetch media.
 *
 * Body: {
 *   phone_number_id: string,
 *   waba_id?: string,
 *   display_phone_number?: string,
 *   access_token?: string,
 * }
 * Returns: { ok: true }
 */
router.post("/me/whatsapp/connect", requireAuth, async (req: Request, res: Response) => {
  const { phone_number_id, waba_id, display_phone_number, access_token } = (req.body ?? {}) as {
    phone_number_id?: string;
    waba_id?: string;
    display_phone_number?: string;
    access_token?: string;
  };

  if (!phone_number_id || typeof phone_number_id !== "string") {
    return res.status(400).json({ error: "phone_number_id is required" });
  }

  // If the caller is sending a new access token, write it to Vault first.
  // We reuse an existing secret row when one already exists for this
  // connection (token rotation) rather than leaking a fresh row per save.
  let accessTokenSecretId: string | null = null;
  if (access_token && typeof access_token === "string" && access_token.trim()) {
    const trimmed = access_token.trim();
    const secretName = `whatsapp_access_token:${phone_number_id}`;

    const { data: existing } = await db
      .from("whatsapp_connections")
      .select("access_token_secret_id")
      .eq("phone_number_id", phone_number_id)
      .maybeSingle();

    const existingSecretId =
      (existing?.access_token_secret_id as string | null | undefined) ?? null;

    if (existingSecretId) {
      const { error: vaultErr } = await db.rpc("vault_update_secret", {
        secret_id: existingSecretId,
        new_secret: trimmed,
      });
      if (vaultErr) return res.status(500).json({ error: `vault update: ${vaultErr.message}` });
      accessTokenSecretId = existingSecretId;
    } else {
      const { data: created, error: vaultErr } = await db.rpc("vault_create_secret", {
        new_secret: trimmed,
        new_name: secretName,
        new_description: "Meta Cloud API Bearer for WhatsApp media fetch",
      });
      if (vaultErr) return res.status(500).json({ error: `vault create: ${vaultErr.message}` });
      accessTokenSecretId = (created as string | null) ?? null;
    }
  }

  // UNIQUE(phone_number_id) means the same Meta number can only belong to one
  // smrtTask user at a time — re-binding clears the previous user. For the
  // single-tenant rollout this matches reality (one DualHook account, one
  // owner). When multi-tenant arrives, we'll switch to onboarding sessions.
  //
  // Single upsert (not delete+insert) so concurrent requests can't race into
  // the UNIQUE constraint between the two statements.
  const updateRow: Record<string, unknown> = {
    user_id: req.user!.id,
    phone_number_id,
    waba_id: waba_id ?? null,
    display_phone_number: display_phone_number ?? null,
    disconnected_at: null,
  };
  // Only update the secret pointer if we just wrote a new/updated token.
  // (If the user re-saves Phone Number ID + WABA without touching the
  //  token field, we keep the existing secret pointer.)
  if (accessTokenSecretId !== null) {
    updateRow.access_token_secret_id = accessTokenSecretId;
  }

  const { error: upsertErr } = await db
    .from("whatsapp_connections")
    .upsert(updateRow, { onConflict: "phone_number_id" });
  if (upsertErr) return res.status(500).json({ error: upsertErr.message });

  // Flip the badge on user_settings so the Settings page shows "connected".
  const { error: updErr } = await db
    .from("user_settings")
    .update({ whatsapp_connected: true })
    .eq("user_id", req.user!.id);
  if (updErr) return res.status(500).json({ error: updErr.message });

  return res.json({ ok: true });
});

/** GET /me/credentials — which services the user has connected (no token data!) */
router.get("/me/credentials", requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("user_credentials")
    .select("service, created_at, updated_at")
    .eq("user_id", req.user!.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ credentials: data ?? [] });
});

/**
 * GET /me/credentials/health
 * Probes each connected service by attempting a token refresh. If Google
 * returns `invalid_grant` (the user revoked access / refresh_token expired),
 * getOAuthClient deletes the credential row, so the returned list reflects
 * the post-cleanup truth. Used by the Settings page so the connection
 * indicators stop saying "connected" forever when the token is dead.
 */
router.get("/me/credentials/health", requireAuth, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { data: creds } = await db
    .from("user_credentials")
    .select("service")
    .eq("user_id", userId);

  if (!creds || creds.length === 0) return res.json({ services: [] });

  const results = await Promise.allSettled(
    creds.map(async (c) => {
      await getOAuthClient(userId, c.service as string);
      return c.service as string;
    }),
  );
  const services = results
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled")
    .map((r) => r.value);

  return res.json({ services });
});

export default router;
