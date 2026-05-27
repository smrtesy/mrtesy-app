/**
 * Admin: system logs. Requires requireSuperAdmin.
 *
 *   GET /admin/logs?level=&range=   platform-wide log_entries (RLS bypassed
 *                                   via the service-role db client)
 *
 * log_entries has RLS `user_id = auth.uid()`, so a user-scoped client only
 * ever sees its own rows. The admin Logs tab needs every user's entries, so
 * it reads through the service-role client behind the super-admin gate.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireSuperAdmin } from "../../../middleware";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

const LEVELS = new Set(["info", "warning", "error"]);
const DAY_MS = 24 * 60 * 60 * 1000;

router.get("/admin/logs", async (req: Request, res: Response) => {
  const level = typeof req.query.level === "string" ? req.query.level : undefined;
  const range = typeof req.query.range === "string" ? req.query.range : "today";

  let query = db
    .from("log_entries")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (level && LEVELS.has(level)) query = query.eq("level", level);

  const now = Date.now();
  let since: string | null = null;
  if (range === "today") {
    const d = new Date(); d.setHours(0, 0, 0, 0); since = d.toISOString();
  } else if (range === "7d") {
    since = new Date(now - 7 * DAY_MS).toISOString();
  } else if (range === "30d") {
    since = new Date(now - 30 * DAY_MS).toISOString();
  }
  if (since) query = query.gte("created_at", since);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ logs: data ?? [] });
});

export default router;
