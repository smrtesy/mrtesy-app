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
 * Write-or-rotate a secret in Vault. If `existingId` is non-null we update
 * that row in place; otherwise we create a fresh secret with the given
 * name/description and return its new uuid. Returns null on error (the
 * caller is responsible for surfacing the error to the user).
 */
async function upsertVaultSecret(
  newValue: string,
  existingId: string | null,
  name: string,
  description: string,
): Promise<{ id: string | null; error: string | null }> {
  if (existingId) {
    const { error } = await db.rpc("vault_update_secret", {
      secret_id: existingId,
      new_secret: newValue,
    });
    if (error) return { id: null, error: `vault update ${name}: ${error.message}` };
    return { id: existingId, error: null };
  }
  const { data, error } = await db.rpc("vault_create_secret", {
    new_secret: newValue,
    new_name: name,
    new_description: description,
  });
  if (error) return { id: null, error: `vault create ${name}: ${error.message}` };
  return { id: (data as string | null) ?? null, error: null };
}

/**
 * POST /me/whatsapp/connect — bind the caller's smrtTask user to a Meta
 * WhatsApp phone number (the IDs visible in their DualHook dashboard) and
 * stash the three Meta secrets they pasted into Supabase Vault.
 *
 * Per-WABA secrets (all go to Vault):
 *   - access_token        Bearer for Meta Cloud API media fetch
 *   - app_secret          HMAC key for X-Hub-Signature-256 validation
 *   - verify_token        Echoed back during Meta's GET handshake
 *
 * Every value is optional in the body: an empty/missing field means "leave
 * the existing one alone", so the user can rotate just one secret without
 * having to re-enter the others.
 *
 * Body: {
 *   phone_number_id:      string,
 *   waba_id?:             string,
 *   business_id?:         string,
 *   display_phone_number?: string,
 *   access_token?:        string,
 *   app_secret?:          string,
 *   verify_token?:        string,
 * }
 * Returns: { ok: true }
 */
router.post("/me/whatsapp/connect", requireAuth, async (req: Request, res: Response) => {
  const {
    phone_number_id,
    waba_id,
    business_id,
    display_phone_number,
    access_token,
    app_secret,
    verify_token,
  } = (req.body ?? {}) as {
    phone_number_id?: string;
    waba_id?: string;
    business_id?: string;
    display_phone_number?: string;
    access_token?: string;
    app_secret?: string;
    verify_token?: string;
  };

  if (!phone_number_id || typeof phone_number_id !== "string") {
    return res.status(400).json({ error: "phone_number_id is required" });
  }

  // Fetch existing secret pointers so we can rotate-in-place instead of
  // orphaning vault rows on every save.
  const { data: existingRow } = await db
    .from("whatsapp_connections")
    .select("access_token_secret_id, app_secret_id, verify_token_id")
    .eq("phone_number_id", phone_number_id)
    .maybeSingle();

  const existingAccessId =
    (existingRow?.access_token_secret_id as string | null | undefined) ?? null;
  const existingAppSecretId =
    (existingRow?.app_secret_id as string | null | undefined) ?? null;
  const existingVerifyId =
    (existingRow?.verify_token_id as string | null | undefined) ?? null;

  // Each of the three is only written when the caller actually sent a value —
  // an empty input is treated as "keep what's already there".
  const updateRow: Record<string, unknown> = {
    user_id: req.user!.id,
    phone_number_id,
    waba_id: waba_id ?? null,
    business_id: business_id ?? null,
    display_phone_number: display_phone_number ?? null,
    disconnected_at: null,
  };

  if (access_token && typeof access_token === "string" && access_token.trim()) {
    const { id, error } = await upsertVaultSecret(
      access_token.trim(),
      existingAccessId,
      `whatsapp_access_token:${phone_number_id}`,
      "Meta Cloud API Bearer for WhatsApp media fetch",
    );
    if (error) return res.status(500).json({ error });
    updateRow.access_token_secret_id = id;
  }

  if (app_secret && typeof app_secret === "string" && app_secret.trim()) {
    const { id, error } = await upsertVaultSecret(
      app_secret.trim(),
      existingAppSecretId,
      `whatsapp_app_secret:${phone_number_id}`,
      "Meta App Secret used to verify X-Hub-Signature-256 on inbound webhooks",
    );
    if (error) return res.status(500).json({ error });
    updateRow.app_secret_id = id;
  }

  if (verify_token && typeof verify_token === "string" && verify_token.trim()) {
    const { id, error } = await upsertVaultSecret(
      verify_token.trim(),
      existingVerifyId,
      `whatsapp_verify_token:${phone_number_id}`,
      "Verify token Meta echoes back during the webhook GET handshake",
    );
    if (error) return res.status(500).json({ error });
    updateRow.verify_token_id = id;
  }

  // UNIQUE(phone_number_id) means the same Meta number can only belong to one
  // smrtTask user at a time — re-binding clears the previous user. For the
  // single-tenant rollout this matches reality (one DualHook account, one
  // owner). When multi-tenant arrives, we'll switch to onboarding sessions.
  //
  // Single upsert (not delete+insert) so concurrent requests can't race into
  // the UNIQUE constraint between the two statements.
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
