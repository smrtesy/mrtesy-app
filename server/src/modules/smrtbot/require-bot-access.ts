import type { Request, Response, NextFunction } from "express";
import { db } from "../../db";

/**
 * Per-bot access guard (permission model ב3).
 *
 * Must run AFTER requireOrg (populates req.member) and requireApp("smrtbot").
 * Allows the request when the user is an org owner/admin (sees all bots) OR
 * has an explicit smrtbot_bot_access row for the bot in the route param.
 *
 * Reads the bot id from req.params[param] (default "botId").
 */
export function requireBotAccess(param = "botId") {
  return async (req: Request, res: Response, next: NextFunction) => {
    const botId = req.params[param];
    if (!botId) {
      return res.status(400).json({ error: `Missing route param: ${param}` });
    }
    if (!req.org || !req.member) {
      return res.status(403).json({ error: "Org context required" });
    }

    // Owners and admins have access to every bot in the org.
    if (req.member.role === "owner" || req.member.role === "admin") {
      return next();
    }

    // Members need an explicit access row.
    const { data, error } = await db
      .from("smrtbot_bot_access")
      .select("id")
      .eq("org_id", req.org.id)
      .eq("bot_id", botId)
      .eq("user_id", req.member.user_id)
      .maybeSingle();

    if (error) {
      return res.status(500).json({ error: error.message });
    }
    if (!data) {
      return res.status(403).json({ error: "No access to this bot" });
    }
    next();
  };
}
