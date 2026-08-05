import { Router, type Request, type Response } from "express";
import { requireAuth, requireOrg } from "../middleware";
import { db } from "../db";

const router = Router();

/**
 * GET /api/inbox/count
 * Returns:
 *   - count: total items that need the user to act (pending suggestions +
 *            unread action_required notifications) — the sidebar badge number
 *   - suggestions: pending task suggestions awaiting review
 *   - notifications: unread notifications of type action_required only
 *            (success/info/warning are informational and do NOT count)
 *   - open_tasks: real tasks (manually_verified=true) currently in inbox or in_progress
 *
 * The sidebar uses `count` for the inbox badge and `open_tasks` for the
 * separate badge on the Tasks nav link.
 */
router.get("/count", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId  = req.org!.id;

  const [tasksRes, notifRes, openTasksRes] = await Promise.all([
    db
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "inbox")
      .eq("manually_verified", false)
      // AI-sourced suggestions (have a source message) OR sourceless Claude-Code
      // session proposals (tagged via-claude-session) — both surface in the
      // suggestions inbox, so both belong in its badge count.
      .or("source_message_id.not.is.null,tags.cs.{via-claude-session}"),
    db
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .eq("is_read", false)
      // The badge counts only notifications that need the user to DO something.
      // The `type` CHECK is ('info','warning','success','action_required'):
      // `success` is a past-run confirmation ("clone finished", "campaign sent"),
      // `info` is FYI, `warning` is heads-up — none demand immediate action.
      // Only `action_required` (reconnect Google, expired token, …) does, so it
      // is the sole type that inflates the badge. inbox_digest is `info`, so this
      // also subsumes the old inbox_digest exclusion.
      .eq("type", "action_required"),
    db
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("manually_verified", true)
      .in("status", ["inbox", "in_progress"]),
  ]);

  const suggestions   = tasksRes.count     ?? 0;
  const notifications = notifRes.count     ?? 0;
  const openTasks     = openTasksRes.count ?? 0;

  res.json({
    count: suggestions + notifications,
    suggestions,
    notifications,
    open_tasks: openTasks,
  });
});

/**
 * PATCH /api/inbox/notifications/:id/read
 * Marks a single notification as read.
 */
router.patch(
  "/notifications/:id/read",
  requireAuth,
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = req.user!.id;

    const { error } = await db
      .from("notifications")
      .update({ is_read: true })
      .eq("id", id)
      .eq("user_id", userId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  },
);

/**
 * PATCH /api/inbox/notifications/read-all
 * Marks all notifications for the user as read.
 */
router.patch(
  "/notifications/read-all",
  requireAuth,
  requireOrg,
  async (req: Request, res: Response) => {
    const userId = req.user!.id;
    const orgId  = req.org!.id;

    const { error } = await db
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", userId)
      .eq("org_id", orgId)
      .eq("is_read", false);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  },
);

export default router;
