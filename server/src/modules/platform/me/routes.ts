/**
 * Per-user routes (no org context needed).
 *
 *   GET    /me/settings        the caller's user_settings row
 *   PATCH  /me/settings        update whitelisted fields
 *   GET    /me/credentials     list which services this user has connected (no tokens leaked)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { google } from "googleapis";
import { db } from "../../../db";
import { requireAuth, isSuperAdmin } from "../../../middleware";
import { getOAuthClient } from "../../../services/token-refresh";

const router = Router();

const UPDATABLE_SETTINGS = new Set([
  "display_name", "timezone", "office_addresses", "skip_senders",
  "skip_recipients", "my_emails", "drive_folder_id", "whatsapp_sheet_id",
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
 * POST /me/whatsapp/test-sheet — verify the caller can read a WhatsApp source
 * Sheet with their connected Google credentials. Used during onboarding before
 * the user has any smrtesy org entitlement, so it gates on requireAuth only.
 *
 * Body: { sheet_id: string, tab?: string }
 * Returns: { ok: true, row_count: number }
 */
router.post("/me/whatsapp/test-sheet", requireAuth, async (req: Request, res: Response) => {
  const { sheet_id, tab } = (req.body ?? {}) as { sheet_id?: string; tab?: string };
  if (!sheet_id || typeof sheet_id !== "string") {
    return res.status(400).json({ error: "sheet_id is required" });
  }

  try {
    const auth = await getOAuthClient(req.user!.id, "gmail_calendar");
    const sheets = google.sheets({ version: "v4", auth });
    // Stay coherent with PART 2 (server/src/modules/smrttask/parts/part2-whatsapp.ts), which
    // reads WHATSAPP_SHEET_TAB from env and only defaults to "Messages".
    // Validating against "Messages" here while runtime reads a different
    // tab would give the user a false-success/false-failure during onboarding.
    const defaultTab = process.env.WHATSAPP_SHEET_TAB ?? "Messages";
    const range = `${tab ?? defaultTab}!A2:A`;
    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: sheet_id, range });
    return res.json({ ok: true, row_count: data.values?.length ?? 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(400).json({ error: msg });
  }
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
