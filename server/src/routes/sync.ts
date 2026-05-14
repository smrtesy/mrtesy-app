/**
 * smrtesy AI sync routes — gated by app_memberships ("smrtesy" must be enabled
 * for the active org). The cron webhook (/run-scheduled) is exempted: it uses a
 * shared secret, runs for any user, and the runners themselves can be made
 * org-aware later (Phase 6.5).
 */

import { Router, Request, Response } from "express";
import { db } from "../db";
import { requireAuth, requireOrg, requireApp } from "../middleware";
import { runPart0 } from "../parts/part0-style";
import { runPart1 } from "../parts/part1-collector";
import { runPart2 } from "../parts/part2-whatsapp";
import { runPart3 } from "../parts/part3-classifier";
import { runPart4 } from "../parts/part4-projects";

const router = Router();

// Every smrtesy route runs through this chain (except the cron webhook below).
const smrtesyGate = [requireAuth, requireOrg, requireApp("smrtesy")];

// ── Part 0: style learner ─────────────────────────────────────────────────
router.post("/part0", ...smrtesyGate, async (req: Request, res: Response) => {
  const { language = "he" } = req.body ?? {};
  try {
    const result = await runPart0({ userId: req.user!.id, language });
    return res.json({ ok: true, session_id: result.sessionId, skipped: result.skipped });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 1: collector (Gmail/Drive/Calendar) ──────────────────────────────
router.post("/part1", ...smrtesyGate, async (req: Request, res: Response) => {
  const { gmail_days, drive_hours } = req.body ?? {};
  try {
    const result = await runPart1({
      userId: req.user!.id,
      gmailDays: gmail_days,
      driveHours: drive_hours,
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 2: WhatsApp ──────────────────────────────────────────────────────
router.post("/part2", ...smrtesyGate, async (req: Request, res: Response) => {
  const { lookback_hours, force } = req.body ?? {};
  try {
    const result = await runPart2({
      userId: req.user!.id,
      lookbackHours: lookback_hours ?? 48,
      force: force ?? false,
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 3: classifier ────────────────────────────────────────────────────
router.post("/part3", ...smrtesyGate, async (req: Request, res: Response) => {
  const { limit } = req.body ?? {};
  try {
    const result = await runPart3({
      userId: req.user!.id,
      orgId: req.org!.id,
      limit: limit ?? 50,
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Part 4: project suggester + brief builder ─────────────────────────────
router.post("/part4/suggest", ...smrtesyGate, async (req: Request, res: Response) => {
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

router.post("/part4/build_brief", ...smrtesyGate, async (req: Request, res: Response) => {
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

  // Check that the user's org has smrtesy enabled before running.
  // Picks the user's primary org (same logic as the auto-fill trigger).
  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", user_id)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!membership) return res.status(403).json({ error: "user has no org" });

  const { data: app } = await db.from("apps").select("id").eq("slug", "smrtesy").maybeSingle();
  const { data: entitled } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("org_id", membership.org_id)
    .eq("app_id", app?.id ?? "")
    .maybeSingle();

  if (!entitled) {
    return res.status(403).json({ error: "smrtesy not enabled for user's org" });
  }

  try {
    if (part === "part1") {
      await runPart1({ userId: user_id });
    } else if (part === "part2") {
      await runPart2({ userId: user_id });
    } else if (part === "part3") {
      // Part 3 is org-aware: cron uses the user's primary org membership.
      await runPart3({ userId: user_id, orgId: membership.org_id as string });
    } else {
      return res.status(400).json({ error: `Unknown part: ${part}` });
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
