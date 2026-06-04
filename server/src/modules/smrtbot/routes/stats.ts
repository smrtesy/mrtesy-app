/**
 * smrtBot — stats (dashboard metrics + drill-downs), ported from botsite stats.js.
 * Org+bot scoped, gated by requireBotAccess. All counts come from the migrated
 * smrtbot_* tables.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireBotAccess } from "../require-bot-access";

const router = Router();

async function countSince(table: string, botId: string, col: string, sinceIso: string | null): Promise<number> {
  let q = db.from(table).select("*", { count: "exact", head: true }).eq("bot_id", botId);
  if (sinceIso) q = q.gte(col, sinceIso);
  const { count } = await q;
  return count ?? 0;
}

const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
const DAY = 86400_000;

// ── dashboard summary ───────────────────────────────────────
router.get("/bot/:botId/stats", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const botId = req.params.botId;
  try {
    const [
      usersTotal, usersActive24h, usersActive7d, usersActive30d,
      msgsTotal, msgs24h, msgs7d,
      childrenTotal, missionsCount, triviaCount, questionsPending,
    ] = await Promise.all([
      countSince("smrtbot_wa_users", botId, "created_at", null),
      countSince("smrtbot_wa_users", botId, "last_interaction_at", iso(DAY)),
      countSince("smrtbot_wa_users", botId, "last_interaction_at", iso(7 * DAY)),
      countSince("smrtbot_wa_users", botId, "last_interaction_at", iso(30 * DAY)),
      countSince("smrtbot_bot_logs", botId, "created_at", null),
      countSince("smrtbot_bot_logs", botId, "created_at", iso(DAY)),
      countSince("smrtbot_bot_logs", botId, "created_at", iso(7 * DAY)),
      countSince("smrtbot_children", botId, "created_at", null),
      countSince("smrtbot_missions", botId, "created_at", null),
      countSince("smrtbot_trivia", botId, "created_at", null),
      (async () => {
        const { count } = await db.from("smrtbot_questions").select("*", { count: "exact", head: true })
          .eq("bot_id", botId).eq("needs_human", true).eq("reply_sent", false);
        return count ?? 0;
      })(),
    ]);

    res.json({
      users: { total: usersTotal, active24h: usersActive24h, active7d: usersActive7d, active30d: usersActive30d },
      messages: { total: msgsTotal, last24h: msgs24h, last7d: msgs7d },
      game: { children: childrenTotal, missions: missionsCount, trivia: triviaCount },
      questionsPending,
    });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : "stats error" });
  }
});

// ── leaderboard (top players by diamonds) ───────────────────
router.get("/bot/:botId/stats/leaderboard", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const { data, error } = await db
    .from("smrtbot_children")
    .select("child_name, phone, diamonds")
    .eq("bot_id", req.params.botId)
    .order("diamonds", { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ leaderboard: data ?? [] });
});

// ── recent message log (drill-down, filterable) ─────────────
router.get("/bot/:botId/stats/logs", requireBotAccess("botId"), async (req: Request, res: Response) => {
  let q = db
    .from("smrtbot_bot_logs")
    .select("phone, direction, env, message_type, body, is_error, created_at")
    .eq("bot_id", req.params.botId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (typeof req.query.phone === "string") q = q.eq("phone", req.query.phone);
  if (typeof req.query.direction === "string") q = q.eq("direction", req.query.direction);
  if (req.query.errors === "true") q = q.eq("is_error", true);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ logs: data ?? [] });
});

export default router;
