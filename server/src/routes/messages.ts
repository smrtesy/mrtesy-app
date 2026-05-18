import { Router, type Request, type Response } from "express";
import { requireAuth, requireOrg } from "../middleware";
import { db } from "../db";
import { notify } from "../lib/platform/notify";

const router = Router();

/**
 * POST /api/messages
 * Send an internal message from one org member to another.
 * The platform routes it as a notification; if the recipient has smrtTask,
 * it appears as a task suggestion via the inbox page.
 */
router.post("/", requireAuth, requireOrg, async (req: Request, res: Response) => {
  const fromUserId = req.user!.id;
  const orgId      = req.org!.id;

  const { to_user_id, type, title, body, link } = req.body ?? {};

  if (!to_user_id || typeof to_user_id !== "string") {
    return res.status(400).json({ error: "to_user_id is required" });
  }
  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }
  if (!["action_required", "info"].includes(type)) {
    return res.status(400).json({ error: "type must be 'action_required' or 'info'" });
  }

  // Verify both users are members of the same org
  const { data: recipient } = await db
    .from("org_members")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", to_user_id)
    .maybeSingle();

  if (!recipient) {
    return res.status(404).json({ error: "Recipient is not a member of this org" });
  }

  await notify(orgId, to_user_id, {
    app_slug:     "platform",
    type,
    title:        title.trim(),
    body:         typeof body === "string" ? body.trim() || undefined : undefined,
    link:         typeof link === "string" ? link.trim() || undefined : undefined,
    from_user_id: fromUserId,
  });

  res.json({ ok: true });
});

export default router;
