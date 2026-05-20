/**
 * smrtTask sync routes — gated by app_memberships ("smrttask" must be enabled
 * for the active org). The cron webhook (/run-scheduled) is exempted: it uses a
 * shared secret, runs for any user, and the runners themselves can be made
 * org-aware later (Phase 6.5).
 */

import { Router, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { runPart0 } from "../parts/part0-style";
import { runPart4 } from "../parts/part4-projects";
import { listCalendars } from "../../../services/calendar";
import { notifyError } from "../../../lib/platform";

const router = Router();

// Every smrtTask route runs through this chain (except the cron webhook below).
const smrttaskGate = [requireAuth, requireOrg, requireApp("smrttask")];

// ── Calendars list ────────────────────────────────────────────────────────
router.get("/calendars", ...smrttaskGate, async (req: Request, res: Response) => {
  try {
    const calendars = await listCalendars(req.user!.id);
    return res.json({ calendars });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 0: style learner ─────────────────────────────────────────────────
router.post("/part0", ...smrttaskGate, async (req: Request, res: Response) => {
  const { language = "he" } = req.body ?? {};
  try {
    const result = await runPart0({ userId: req.user!.id, language });
    return res.json({ ok: true, session_id: result.sessionId, skipped: result.skipped });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 1: collector — proxied to the Supabase gmail-sync + drive-sync Edge Functions ──
// The Express part1-collector was deleted; gmail-sync (cron every 2 min) and
// drive-sync (cron every 6h) are the only collectors. This endpoint kicks them
// off immediately so manual "Sync Now" doesn't wait for the next cron tick.
//
// Calendar collection happens via push (calendar-webhook Edge Function),
// driven by calendar-renew-watch establishing a Google watch channel — there
// is no on-demand "pull all calendar events" path. If the user's Calendar
// watch isn't established, calendar-renew-watch is what fixes it.
router.post("/part1", ...smrttaskGate, async (req: Request, res: Response) => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!supabaseUrl || !cronSecret) {
    return res.status(500).json({ error: "SUPABASE_URL / CRON_SECRET not configured" });
  }

  const headers = { "Content-Type": "application/json", "x-cron-secret": cronSecret } as const;

  type EdgeResult = { ok: boolean; status: number; body: unknown };
  async function kick(slug: string): Promise<EdgeResult> {
    try {
      const resp = await fetch(`${supabaseUrl}/functions/v1/${slug}`, { method: "POST", headers });
      const body = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: { error: e instanceof Error ? e.message : String(e) } };
    }
  }

  const [gmail, drive] = await Promise.all([kick("gmail-sync"), kick("drive-sync")]);

  if (!gmail.ok && !drive.ok) {
    return res.status(502).json({ error: "Both gmail-sync and drive-sync failed", gmail, drive });
  }
  // Keep `session_id` so the existing UI toast renders cleanly. The Edge
  // Functions write their own log_entries rows for progress.
  return res.json({ ok: true, session_id: "gmail-sync+drive-sync", gmail, drive });
});

// Part 2 (WhatsApp) intentionally removed: WhatsApp ingestion is now
// event-driven via the Vercel Route Handler at
// src/app/api/webhooks/whatsapp/route.ts. The previous /part2 route pulled
// from a Google Sheet on a 15-min cron.

// ── Part 3: classifier — proxied to the Supabase ai-process Edge Function ──
// The Express part3-classifier was deleted in this same commit; ai-process
// (Supabase Edge) is now the only classifier. This endpoint kicks it off
// immediately so the user doesn't have to wait for the next cron tick.
//
// The body { limit } from the legacy UI is ignored — ai-process reads
// batch_size from smrttask_system_params instead.
router.post("/part3", ...smrttaskGate, async (req: Request, res: Response) => {
  // SUPABASE_URL is the server-side var (Railway, server runtime).
  // NEXT_PUBLIC_SUPABASE_URL is a fallback for environments where only the
  // client-facing var is set.
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const cronSecret = process.env.CRON_SECRET;
  if (!supabaseUrl || !cronSecret) {
    return res.status(500).json({ error: "SUPABASE_URL / CRON_SECRET not configured" });
  }

  try {
    const resp = await fetch(`${supabaseUrl}/functions/v1/ai-process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": cronSecret,
      },
    });
    const body = (await resp.json()) as { error?: string; processed?: number; deferred?: number; batchSize?: number };
    if (!resp.ok) {
      return res.status(resp.status).json({ error: body?.error ?? `ai-process returned ${resp.status}` });
    }
    // Keep `session_id` in the response so the existing sync UI's toast
    // doesn't say "undefined". ai-process doesn't write to run_sessions —
    // its progress lives in log_entries with category='ai_process'.
    return res.json({ ok: true, session_id: "ai-process", ...body });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 4: project suggester + brief builder ─────────────────────────────
router.post("/part4/suggest", ...smrttaskGate, async (req: Request, res: Response) => {
  try {
    const result = await runPart4({
      userId: req.user!.id,
      orgId: req.org!.id,
      mode: "suggest",
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/part4/build_brief", ...smrttaskGate, async (req: Request, res: Response) => {
  const { project_id } = req.body ?? {};
  if (!project_id) return res.status(400).json({ error: "project_id required" });
  try {
    const result = await runPart4({
      userId: req.user!.id,
      orgId: req.org!.id,
      mode: "build_brief",
      projectId: project_id,
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Run sessions status (scoped to caller's user_id, not org-wide yet) ────
router.get("/status", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("run_sessions")
    .select("*")
    .eq("user_id", req.user!.id)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ sessions: data });
});

// ── Cron webhook ──────────────────────────────────────────────────────────
// Called by the in-process node-cron scheduler. Uses a shared secret so it
// can run jobs for any user without going through JWT auth.
router.post("/run-scheduled", async (req: Request, res: Response) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { part, user_id } = req.body ?? {};
  if (!part || !user_id) return res.status(400).json({ error: "part and user_id required" });

  // Check that the user's org has smrttask enabled before running.
  // Picks the user's primary org (same logic as the auto-fill trigger).
  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", user_id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership) return res.status(403).json({ error: "user has no org" });

  const { data: app } = await db.from("apps").select("id").eq("slug", "smrttask").maybeSingle();
  const { data: entitled } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("org_id", membership.org_id)
    .eq("app_id", app?.id ?? "")
    .maybeSingle();

  if (!entitled) {
    return res.status(403).json({ error: "smrttask not enabled for user's org" });
  }

  try {
    if (part === "part1" || part === "part3") {
      // Collection (part1) and classification (part3) both moved to Supabase
      // Edge Functions with their own cron in Supabase. Railway's scheduler
      // has nothing to do for these — treat existing rows as no-ops until
      // they age out.
    } else {
      return res.status(400).json({ error: `Unknown part: ${part}` });
    }
    return res.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Cron failure — no interactive caller, so surface to the org error handler.
    await notifyError(membership.org_id as string, "smrttask", {
      title: `smrtTask ${part} sync failed`,
      body:  message,
      link:  "/log",
    });
    return res.status(500).json({ error: message });
  }
});

export default router;
