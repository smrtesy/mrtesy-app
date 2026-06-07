/**
 * smrtBot — web-chat internal route (machine-to-machine).
 *
 * The public Next.js route (/api/bot/web/[key]/*) forwards browser traffic
 * here so the conversation engine runs on the long-running Railway server, the
 * same way the WhatsApp webhook forwards to /api/bot/internal/inbound. Guarded
 * by the shared internal secret (NOT the user auth chain), so it is mounted
 * before the auth guards in index.ts.
 *
 * The web channel reuses the WhatsApp engine verbatim via the BotChannel
 * abstraction: inbound is normalised to the same InboundMessage shape, and
 * outbound replies are persisted to smrtbot_web_messages + broadcast over
 * Supabase Realtime to the visitor's session topic (see channel.ts).
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { randomBytes, randomUUID } from "crypto";

import { db } from "../../db";
import { handleInbound, type BotRow } from "./engine";
import { WebChannel, webTopic, type WebMessageKind } from "./channel";
import { reportError, errInfo } from "./report-error";

const router = Router();

const BOT_FIELDS =
  "id, org_id, slug, web_enabled, web_env, web_allowed_origins, web_greeting, web_accent_color";

function secretOk(req: Request): boolean {
  const expected = process.env.SMRTBOT_INTERNAL_SECRET || process.env.CRON_SECRET || "";
  if (!expected) return false;
  return req.get("x-smrtbot-secret") === expected;
}

interface WebBotRow {
  id: string;
  org_id: string;
  slug: string;
  web_enabled: boolean | null;
  web_env: string | null;
  web_allowed_origins: string[] | null;
  web_greeting: string | null;
  web_accent_color: string | null;
}

interface WebMessageRow {
  id: string;
  direction: string;
  kind: WebMessageKind;
  body: string;
  payload: Record<string, unknown>;
  created_at: string;
}

/** A bot row carries no WhatsApp creds in web mode — the engine never resolves
 *  them because we hand it a WebChannel. Cast through BotRow for the shared
 *  signature; only org_id / id / slug are read on the web path. */
function asEngineBot(bot: WebBotRow): BotRow {
  return { id: bot.id, org_id: bot.org_id, slug: bot.slug } as BotRow;
}

async function loadBotById(botId: string): Promise<WebBotRow | null> {
  const { data } = await db.from("smrtbot_bots").select(BOT_FIELDS).eq("id", botId).maybeSingle();
  return (data as WebBotRow | null) ?? null;
}

async function recentMessages(sessionId: string, sinceIso?: string): Promise<WebMessageRow[]> {
  let q = db
    .from("smrtbot_web_messages")
    .select("id, direction, kind, body, payload, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  if (sinceIso) q = q.gt("created_at", sinceIso);
  const { data } = await q;
  return (data as WebMessageRow[]) ?? [];
}

// ── POST /api/bot/internal/web-start — open a session + send the welcome ──────
router.post("/api/bot/internal/web-start", async (req: Request, res: Response) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });

  const { bot_id, lead, origin, user_agent } = (req.body ?? {}) as {
    bot_id?: string;
    lead?: { name?: string; email?: string; phone?: string };
    origin?: string;
    user_agent?: string;
  };

  const email = (lead?.email ?? "").trim();
  if (!bot_id || !email) {
    return res.status(400).json({ error: "bot_id and lead.email are required" });
  }

  const bot = await loadBotById(bot_id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (!bot.web_enabled) return res.status(403).json({ error: "web chat is not enabled for this bot" });

  const env = bot.web_env === "test" ? "test" : "live";
  const sessionToken = randomBytes(24).toString("base64url");
  const participantKey = `web:${randomUUID()}`;

  const { data: session, error: sErr } = await db
    .from("smrtbot_web_sessions")
    .insert({
      org_id: bot.org_id,
      bot_id: bot.id,
      session_token: sessionToken,
      participant_key: participantKey,
      lead_name: lead?.name?.trim() || null,
      lead_email: email,
      lead_phone: lead?.phone?.trim() || null,
      origin: origin ?? null,
      user_agent: user_agent ?? null,
      env,
    })
    .select("id")
    .single();
  if (sErr || !session) {
    return res.status(500).json({ error: sErr?.message ?? "could not create session" });
  }

  const channel = new WebChannel({
    orgId: bot.org_id,
    botId: bot.id,
    sessionId: session.id,
    sessionToken,
  });

  // Run the engine with an empty inbound → it lands the visitor on the root
  // menu (the new-user welcome path), exactly like a first WhatsApp message.
  try {
    await handleInbound(
      asEngineBot(bot),
      env,
      { from: participantKey, name: lead?.name?.trim() || null, type: "text", text: "" },
      channel,
    );
  } catch (e) {
    const { message, stack } = errInfo(e);
    await reportError(bot.org_id, {
      area: "engine",
      title: "Web-chat welcome failed",
      message,
      botId: bot.id,
      stack,
      details: { bot: bot.slug, participantKey },
    });
  }

  const messages = await recentMessages(session.id);
  return res.json({
    session_token: sessionToken,
    participant_key: participantKey,
    topic: webTopic(sessionToken),
    accent_color: bot.web_accent_color ?? null,
    greeting: bot.web_greeting ?? null,
    messages,
  });
});

// ── POST /api/bot/internal/web-message — a visitor turn ───────────────────────
router.post("/api/bot/internal/web-message", async (req: Request, res: Response) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });

  const { session_token, text, buttonId } = (req.body ?? {}) as {
    session_token?: string;
    text?: string;
    buttonId?: string;
  };
  if (!session_token || (!text && !buttonId)) {
    return res.status(400).json({ error: "session_token and text or buttonId are required" });
  }

  const { data: session } = await db
    .from("smrtbot_web_sessions")
    .select("id, org_id, bot_id, participant_key, env")
    .eq("session_token", session_token)
    .maybeSingle();
  if (!session) return res.status(404).json({ error: "session not found" });

  const bot = await db.from("smrtbot_bots").select(BOT_FIELDS).eq("id", session.bot_id).maybeSingle();
  const botRow = bot.data as WebBotRow | null;
  if (!botRow || !botRow.web_enabled) {
    return res.status(403).json({ error: "web chat is not enabled for this bot" });
  }

  const env = session.env === "test" ? "test" : "live";

  const { error: seenErr } = await db
    .from("smrtbot_web_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", session.id);
  if (seenErr) console.error("[smrtbot/web] last_seen update", seenErr.message);

  // Persist the inbound bubble so history/reload reconstructs the full thread.
  // The browser renders its own outgoing bubble optimistically, so we don't
  // broadcast inbound — only the engine's replies are pushed back.
  const { error: inErr } = await db.from("smrtbot_web_messages").insert({
    org_id: session.org_id,
    bot_id: session.bot_id,
    session_id: session.id,
    direction: "in",
    kind: "text",
    body: text ?? buttonId ?? "",
    payload: buttonId ? { buttonId } : {},
  });
  if (inErr) console.error("[smrtbot/web] inbound persist", inErr.message);

  const channel = new WebChannel({
    orgId: session.org_id,
    botId: session.bot_id,
    sessionId: session.id,
    sessionToken: session_token,
  });

  // Ack fast; run the engine without blocking — replies arrive via Realtime.
  res.json({ ok: true });
  try {
    await handleInbound(
      asEngineBot(botRow),
      env,
      { from: session.participant_key, type: "text", text, buttonId },
      channel,
    );
  } catch (e) {
    const { message, stack } = errInfo(e);
    await reportError(session.org_id, {
      area: "engine",
      title: "Web-chat message failed",
      message,
      botId: session.bot_id,
      stack,
      details: { session_id: session.id },
    });
  }
});

// ── GET /api/bot/internal/web-history — reload/reconnect backlog ───────────────
router.get("/api/bot/internal/web-history", async (req: Request, res: Response) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });

  const sessionToken = String(req.query.session_token ?? "");
  const since = req.query.since ? String(req.query.since) : undefined;
  if (!sessionToken) return res.status(400).json({ error: "session_token is required" });

  const { data: session } = await db
    .from("smrtbot_web_sessions")
    .select("id")
    .eq("session_token", sessionToken)
    .maybeSingle();
  if (!session) return res.status(404).json({ error: "session not found" });

  const messages = await recentMessages(session.id, since);
  return res.json({ messages });
});

export default router;
