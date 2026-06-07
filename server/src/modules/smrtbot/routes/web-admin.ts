/**
 * smrtBot — web-chat admin routes (the "Web conversations" view).
 *
 * Org+bot scoped, gated by requireBotAccess. Lets the bot owner browse the
 * lead sessions captured by the web widget and read each full thread from
 * smrtbot_web_messages. Read-only.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireBotAccess } from "../require-bot-access";

const router = Router();

// ── List web-chat sessions for a bot (most recent first) ─────
router.get("/bot/:botId/web/sessions", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_web_sessions")
    .select("id, lead_name, lead_email, lead_phone, origin, last_seen_at, created_at")
    .eq("org_id", req.org!.id)
    .eq("bot_id", req.params.botId)
    .order("last_seen_at", { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ sessions: data ?? [] });
});

// ── Read one session's full thread ───────────────────────────
router.get(
  "/bot/:botId/web/sessions/:sessionId/messages",
  requireBotAccess("botId"),
  async (req: Request, res: Response) => {
    // Confirm the session belongs to this bot+org before returning messages.
    const { data: session, error: sErr } = await db
      .from("smrtbot_web_sessions")
      .select("id")
      .eq("org_id", req.org!.id)
      .eq("bot_id", req.params.botId)
      .eq("id", req.params.sessionId)
      .maybeSingle();
    if (sErr) return res.status(500).json({ error: sErr.message });
    if (!session) return res.status(404).json({ error: "session not found" });

    const { data, error } = await db
      .from("smrtbot_web_messages")
      .select("id, direction, kind, body, payload, created_at")
      .eq("session_id", req.params.sessionId)
      .order("created_at", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ messages: data ?? [] });
  },
);

export default router;
