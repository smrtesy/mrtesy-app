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
import {
  resolveCreds,
  sendTemplate,
  sendText,
  type BotEnv,
} from "./wa";
import { sendBaileysText, toJid } from "./baileys";

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
      "id, org_id, slug, timezone, public_phone_number, live_phone_display, wa_phone_number_id, wa_access_token, test_wa_phone_number_id, test_wa_access_token, live_wa_phone_number_id, live_wa_access_token",
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
      env: env === "test" ? "test" : "live",
      stack,
      details: { inbound: message },
    });
  }
});

// ── send-service: the seam smrtReach calls for broadcast campaigns ──────────
// smrtReach hands off a bounded batch; smrtBot owns the send (creds, throttle,
// opt-out enforcement, retries via wa.ts) and returns per-recipient results.
// Shared-secret guarded, same as the inbound route above.
interface SendRecipient {
  phone: string;
  contact_id?: string | null;
}
interface SendResult {
  phone: string;
  contact_id: string | null;
  status: "sent" | "failed" | "skipped";
  wa_message_id?: string | null;
  error?: string;
}

router.post("/api/bot/internal/send", async (req: Request, res: Response) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });

  const { bot_id, env, recipients, template, text } = (req.body ?? {}) as {
    bot_id?: string;
    env?: BotEnv;
    recipients?: SendRecipient[];
    template?: { name: string; lang: string; components?: unknown[] };
    text?: string;
  };

  if (!bot_id || !Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: "bot_id and a non-empty recipients array are required" });
  }
  if (!template?.name && !text) {
    return res.status(400).json({ error: "either template or text is required" });
  }
  if (recipients.length > 200) {
    return res.status(400).json({ error: "batch limited to 200 recipients" });
  }

  const { data: bot, error } = await db
    .from("smrtbot_bots")
    .select(
      "id, org_id, transport, wa_phone_number_id, wa_access_token, test_wa_phone_number_id, test_wa_access_token, live_wa_phone_number_id, live_wa_access_token",
    )
    .eq("id", bot_id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!bot) return res.status(404).json({ error: "bot not found" });

  // ── Unofficial transport (Baileys) ──────────────────────────────────────
  // The WhatsApp-Web connection sends free-form text to a JID (group …@g.us
  // or contact …@s.whatsapp.net). Meta templates don't apply here; broadcasts
  // carry `text`. Per-user opt-out is enforced for 1:1 sends, not group JIDs.
  if ((bot as { transport?: string }).transport === "baileys") {
    if (!text) {
      return res.status(400).json({ error: "baileys transport requires text" });
    }
    const results: SendResult[] = [];
    for (const r of recipients) {
      if (!r.phone) {
        results.push({ phone: "", contact_id: r.contact_id ?? null, status: "skipped", error: "no phone" });
        continue;
      }
      const jid = toJid(r.phone);
      const isGroup = jid.endsWith("@g.us");
      if (!isGroup) {
        const { data: waUser } = await db
          .from("smrtbot_wa_users")
          .select("wa_opted_out")
          .eq("bot_id", bot_id)
          .eq("phone", r.phone)
          .maybeSingle();
        if (waUser?.wa_opted_out) {
          results.push({ phone: r.phone, contact_id: r.contact_id ?? null, status: "skipped", error: "opted out" });
          continue;
        }
      }
      const sent = await sendBaileysText(bot_id, jid, text);
      results.push({
        phone: r.phone,
        contact_id: r.contact_id ?? null,
        status: sent.status,
        wa_message_id: sent.wa_message_id ?? null,
        error: sent.error,
      });
    }
    return res.json({ results });
  }

  const useEnv: BotEnv = env === "test" ? "test" : "live";
  const creds = resolveCreds(bot as Parameters<typeof resolveCreds>[0], useEnv);
  if (!creds) return res.status(400).json({ error: `bot has no ${useEnv} WhatsApp credentials` });

  const results: SendResult[] = [];
  for (const r of recipients) {
    if (!r.phone) {
      results.push({ phone: "", contact_id: r.contact_id ?? null, status: "skipped", error: "no phone" });
      continue;
    }
    // Enforce opt-out (smrtBot owns this — smrtReach must not bypass it).
    const { data: waUser } = await db
      .from("smrtbot_wa_users")
      .select("wa_opted_out")
      .eq("bot_id", bot_id)
      .eq("phone", r.phone)
      .maybeSingle();
    if (waUser?.wa_opted_out) {
      results.push({ phone: r.phone, contact_id: r.contact_id ?? null, status: "skipped", error: "opted out" });
      continue;
    }

    try {
      const sent = template?.name
        ? await sendTemplate(creds, r.phone, template.name, template.lang, template.components)
        : await sendText(creds, r.phone, text as string);
      results.push({
        phone: r.phone,
        contact_id: r.contact_id ?? null,
        status: "sent",
        wa_message_id: sent.wa_message_id,
      });
    } catch (e) {
      // WhatsAppSendError.message is now Meta's decoded, human-readable reason.
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ phone: r.phone, contact_id: r.contact_id ?? null, status: "failed", error: msg });
    }
  }

  res.json({ results });
});

export default router;
