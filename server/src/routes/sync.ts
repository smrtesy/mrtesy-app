/**
 * POST /api/sync/part2  — run WhatsApp sync for a user
 * POST /api/sync/part3  — run Deep Classifier for a user
 * GET  /api/sync/status — get latest run sessions for a user
 */

import { Router, Request, Response } from "express";
import { db } from "../db";
import { runPart0 } from "../parts/part0-style";
import { runPart1 } from "../parts/part1-collector";
import { runPart2 } from "../parts/part2-whatsapp";
import { runPart3 } from "../parts/part3-classifier";

const router = Router();

// Auth middleware: verify Bearer token = Supabase user JWT
async function getUserId(req: Request): Promise<string | null> {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

router.post("/part0", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { language = "he" } = req.body ?? {};
  try {
    const result = await runPart0({ userId, language });
    return res.json({ ok: true, session_id: result.sessionId, skipped: result.skipped });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/part1", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { gmail_days, drive_hours } = req.body ?? {};
  try {
    const result = await runPart1({ userId, gmailDays: gmail_days, driveHours: drive_hours });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    return res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/part2", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { lookback_hours, force } = req.body ?? {};
  try {
    const result = await runPart2({
      userId,
      lookbackHours: lookback_hours ?? 48,
      force: force ?? false,
    });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

router.post("/part3", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { limit } = req.body ?? {};
  try {
    const result = await runPart3({ userId, limit: limit ?? 50 });
    return res.json({ ok: true, session_id: result.sessionId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

router.get("/status", async (req: Request, res: Response) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const { data, error } = await db
    .from("run_sessions")
    .select("*")
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ sessions: data });
});

// Webhook from scheduler: run auto-schedules (called by node-cron internally)
router.post("/run-scheduled", async (req: Request, res: Response) => {
  const secret = req.headers["x-cron-secret"];
  if (secret !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { part, user_id } = req.body ?? {};
  if (!part || !user_id) return res.status(400).json({ error: "part and user_id required" });

  try {
    if (part === "part1") {
      await runPart1({ userId: user_id });
    } else if (part === "part2") {
      await runPart2({ userId: user_id });
    } else if (part === "part3") {
      await runPart3({ userId: user_id });
    } else {
      return res.status(400).json({ error: `Unknown part: ${part}` });
    }
    return res.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

export default router;
