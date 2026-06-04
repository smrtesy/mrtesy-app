/**
 * smrtBot — Q&A actions: send an admin reply to the user over WhatsApp, and
 * promote a question+answer into the FAQ (knowledge base). Ported from
 * botsite questionsRoutes.js.
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { requireBotAccess } from "../require-bot-access";
import { resolveCreds, sendText, type BotCreds } from "../wa";

const router = Router();

const BOT_SELECT =
  "wa_phone_number_id, wa_access_token, live_wa_phone_number_id, live_wa_access_token, test_wa_phone_number_id, test_wa_access_token";

// Send the (admin) reply to the asker over WhatsApp, mark the question answered.
router.post("/bot/:botId/questions/:id/reply", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const botId = req.params.botId;
  const replyText = typeof req.body?.text === "string" && req.body.text.trim() ? req.body.text.trim() : null;

  const { data: q, error: qErr } = await db
    .from("smrtbot_questions")
    .select("id, phone, admin_reply")
    .eq("org_id", orgId).eq("bot_id", botId).eq("id", req.params.id)
    .maybeSingle();
  if (qErr) return res.status(500).json({ error: qErr.message });
  if (!q) return res.status(404).json({ error: "question not found" });
  const body = replyText ?? (q.admin_reply as string | null);
  if (!body) return res.status(400).json({ error: "no reply text" });
  if (!q.phone) return res.status(400).json({ error: "question has no phone" });

  const { data: bot } = await db.from("smrtbot_bots").select(BOT_SELECT).eq("id", botId).maybeSingle();
  const creds = bot ? resolveCreds(bot as BotCreds, "live") : null;
  if (!creds) return res.status(400).json({ error: "bot has no live WhatsApp credentials" });

  try {
    await sendText(creds, q.phone as string, body);
  } catch (e) {
    return res.status(502).json({ error: e instanceof Error ? e.message : "send failed" });
  }

  const { error: upErr } = await db
    .from("smrtbot_questions")
    .update({
      admin_reply: body, reply_sent: true, reply_sent_at: new Date().toISOString(),
      status: "answered", replied_by: req.user!.email ?? req.user!.id,
    })
    .eq("org_id", orgId).eq("bot_id", botId).eq("id", req.params.id);
  if (upErr) return res.status(500).json({ error: upErr.message });
  res.json({ ok: true });
});

// Promote the question+answer into the FAQ (knowledge base).
router.post("/bot/:botId/questions/:id/promote", requireBotAccess("botId"), async (req: Request, res: Response) => {
  const orgId = req.org!.id;
  const botId = req.params.botId;
  const { data: q, error: qErr } = await db
    .from("smrtbot_questions")
    .select("message_text, admin_reply")
    .eq("org_id", orgId).eq("bot_id", botId).eq("id", req.params.id)
    .maybeSingle();
  if (qErr) return res.status(500).json({ error: qErr.message });
  if (!q) return res.status(404).json({ error: "question not found" });
  if (!q.admin_reply) return res.status(400).json({ error: "answer the question before promoting it" });

  const { error: insErr } = await db.from("smrtbot_knowledge_base").insert({
    org_id: orgId, bot_id: botId,
    question_pattern: q.message_text as string,
    keywords: q.message_text as string,
    answer: q.admin_reply as string,
    env: "live", active: true,
  });
  if (insErr) return res.status(500).json({ error: insErr.message });

  await db.from("smrtbot_questions").update({ status: "answered" }).eq("org_id", orgId).eq("bot_id", botId).eq("id", req.params.id);
  res.json({ ok: true });
});

export default router;
