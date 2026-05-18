/**
 * Reminder routes — base module.
 *
 *   GET    /reminders                      list reminders for active org
 *   POST   /reminders                      create reminder
 *   PATCH  /reminders/:id                  update (pause, change time, message)
 *   DELETE /reminders/:id                  delete
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";

const router = Router();

// Every reminder route requires auth + active org + smrtTask enabled for that org.
router.use(requireAuth, requireOrg, requireApp("smrttask"));

const UPDATABLE_FIELDS = new Set([
  "remind_at", "channel", "message", "message_he", "title_he",
  "recurrence_rule", "is_active", "paused_until", "next_occurrence",
  "task_id", "source",
]);

function pick(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(body)) if (UPDATABLE_FIELDS.has(k)) out[k] = body[k];
  return out;
}

/** GET /reminders?active=true&task_id=...&limit=50 */
router.get("/reminders", async (req: Request, res: Response) => {
  const { active, task_id, limit } = req.query;

  let q = db
    .from("reminders")
    .select("*, tasks(id, title, title_he, status)")
    .eq("organization_id", req.org!.id);

  if (active === "true")  q = q.eq("is_active", true);
  if (active === "false") q = q.eq("is_active", false);
  if (typeof task_id === "string") q = q.eq("task_id", task_id);

  q = q.order("remind_at", { ascending: true });
  const n = Math.min(parseInt((limit as string) ?? "50", 10) || 50, 200);
  q = q.limit(n);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ reminders: data ?? [] });
});

/** POST /reminders */
router.post("/reminders", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  if (!body.remind_at) {
    return res.status(400).json({ error: "remind_at is required" });
  }
  if (!body.message && !body.message_he) {
    return res.status(400).json({ error: "message or message_he is required" });
  }

  const payload = {
    user_id: req.user!.id,
    organization_id: req.org!.id,
    is_active: true,
    ...pick(body),
  };

  const { data, error } = await db
    .from("reminders")
    .insert(payload)
    .select("*")
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ reminder: data });
});

/** PATCH /reminders/:id */
router.patch("/reminders/:id", async (req: Request, res: Response) => {
  const updates = pick(req.body ?? {});
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "nothing to update" });
  }

  const { data, error } = await db
    .from("reminders")
    .update(updates)
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id)
    .select("*")
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: "reminder not found in this org" });
  res.json({ reminder: data });
});

/** DELETE /reminders/:id */
router.delete("/reminders/:id", async (req: Request, res: Response) => {
  const { error, count } = await db
    .from("reminders")
    .delete({ count: "exact" })
    .eq("organization_id", req.org!.id)
    .eq("id", req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  if (count === 0) return res.status(404).json({ error: "reminder not found in this org" });
  res.json({ ok: true });
});

export default router;
