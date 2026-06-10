/**
 * smrtTask sync routes — gated by app_memberships ("smrttask" must be enabled
 * for the active org). The cron webhook (/run-scheduled) is exempted: it uses a
 * shared secret, runs for any user, and the runners themselves can be made
 * org-aware later (Phase 6.5).
 */

import { Router, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp, rateLimit } from "../../../middleware";
import { runPart0 } from "../parts/part0-style";
import { runPart1 } from "../parts/part1-collector";
import { runPart4 } from "../parts/part4-projects";
import { listCalendars } from "../../../services/calendar";
import { notifyError } from "../../../lib/platform";

const router = Router();

// Every smrtTask route runs through this chain (except the cron webhook below).
const smrttaskGate = [requireAuth, requireOrg, requireApp("smrttask")];

// Per-user cap on the heavy ingest/LLM endpoints. A genuine user never needs to
// kick off a full sync or project-brief build more than a handful of times a
// minute; this stops a runaway client or abuse from exhausting Google quota and
// burning LLM tokens. Keyed by user id (req.user is set by requireAuth above).
const heavySyncLimit = rateLimit({
  windowMs: 60_000,
  max: 6,
  message: "Too many sync requests — please wait a moment before retrying.",
});

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
router.post("/part0", ...smrttaskGate, heavySyncLimit, async (req: Request, res: Response) => {
  const { language = "he" } = req.body ?? {};
  try {
    const result = await runPart0({ userId: req.user!.id, language });
    return res.json({ ok: true, session_id: result.sessionId, skipped: result.skipped });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 1: collector (Gmail/Drive/Calendar) ──────────────────────────────
router.post("/part1", ...smrttaskGate, heavySyncLimit, async (req: Request, res: Response) => {
  const { gmail_days, drive_hours, cal_months, drive_folder_id } = req.body ?? {};
  try {
    const result = await runPart1({
      userId: req.user!.id,
      gmailDays: gmail_days,
      driveHours: drive_hours,
      calMonths: cal_months,
      driveFolderId: drive_folder_id,
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Part 2 (WhatsApp) intentionally removed: WhatsApp ingestion is now
// event-driven via /api/webhooks/whatsapp (see whatsapp-webhook.ts). The
// previous /part2 route pulled from a Google Sheet on a 15-min cron.

// Part 3 (classifier) intentionally removed: classification is now handled
// by the ai-process edge function running every minute via pg_cron.

// ── Part 4: project suggester + brief builder ─────────────────────────────
router.post("/part4/suggest", ...smrttaskGate, heavySyncLimit, async (req: Request, res: Response) => {
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

router.post("/part4/build_brief", ...smrttaskGate, heavySyncLimit, async (req: Request, res: Response) => {
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

// ── Cancel a stuck/running sync session ───────────────────────────────────
// Marks one or all currently-running sessions as failed for the caller. The
// backend pipelines (runPart1) are best-effort interruptible by
// flipping the row to 'failed' — the workers won't notice mid-run, but the UI
// stops blocking on the stale "running" indicator and future runs are allowed.
//   POST /api/sync/cancel  body: { session_id?: string }
router.post("/cancel", ...smrttaskGate, async (req: Request, res: Response) => {
  const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : null;
  const now = new Date().toISOString();

  let q = db
    .from("run_sessions")
    .update({
      status: "failed",
      ended_at: now,
      summary: "Cancelled by user",
    }, { count: "exact" })
    .eq("user_id", req.user!.id)
    .eq("status", "running");

  if (sessionId) q = q.eq("id", sessionId);

  const { count, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, cancelled: count ?? 0 });
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
    if (part === "part1") {
      await runPart1({ userId: user_id });
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
