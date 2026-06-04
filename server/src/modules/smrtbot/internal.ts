/**
 * smrtBot — internal inbound route (machine-to-machine).
 *
 * The Vercel webhook (per-bot) forwards each inbound WhatsApp message here so
 * the conversation engine runs on the long-running Railway server (where wa.ts
 * keeps its per-number throttle). Guarded by a shared secret, NOT the user auth
 * chain — so it is mounted before the auth guards in index.ts (like the
 * smrtTask/smrtVoice webhook routers).
 *
 * This same router will host the send-service endpoint smrtReach calls for
 * broadcast (defined in the smrtReach phase).
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { handleInbound, type BotRow, type InboundMessage } from "./engine";
import { reportError, errInfo } from "./report-error";
import type { BotEnv } from "./wa";

const router = Router();

function secretOk(req: Request): boolean {
  const expected = process.env.SMRTBOT_INTERNAL_SECRET || process.env.CRON_SECRET || "";
  if (!expected) return false;
  return req.get("x-smrtbot-secret") === expected;
}

router.post("/api/bot/internal/inbound", async (req: Request, res: Response) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });

  const { bot_id, env, message } = (req.body ?? {}) as {
    bot_id?: string;
    env?: BotEnv;
    message?: InboundMessage;
  };
  if (!bot_id || !message?.from) {
    return res.status(400).json({ error: "bot_id and message.from are required" });
  }

  const { data: bot, error } = await db
    .from("smrtbot_bots")
    .select(
      "id, org_id, slug, wa_phone_number_id, wa_access_token, test_wa_phone_number_id, test_wa_access_token, live_wa_phone_number_id, live_wa_access_token",
    )
    .eq("id", bot_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!bot) return res.status(404).json({ error: "bot not found" });

  // Ack fast; run the engine without blocking the response.
  res.json({ ok: true });
  try {
    await handleInbound(bot as BotRow, env === "test" ? "test" : "live", message);
  } catch (e) {
    const { message: msg, stack } = errInfo(e);
    await reportError((bot as BotRow).org_id, {
      area: "engine",
      title: "Inbound handler crashed",
      message: msg,
      botId: (bot as BotRow).id,
      stack,
      details: { inbound: message },
    });
  }
});

export default router;
