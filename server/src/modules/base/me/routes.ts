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

/** GET /me/credentials — which services the user has connected (no token data!) */
router.get("/me/credentials", requireAuth, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("user_credentials")
    .select("service, created_at, updated_at")
    .eq("user_id", req.user!.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ credentials: data ?? [] });
});

export default router;
