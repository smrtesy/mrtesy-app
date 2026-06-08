/**
 * smrtBot — scheduled job routes (cron model ג3).
 *
 * pg_cron (via pg_net) calls these bounded endpoints; the heavy/long work stays
 * here on the Railway server where wa.ts holds its throttle. Shared-secret
 * guarded (same secret as the internal inbound route), mounted before the auth
 * chain.
 *
 *   /api/bot/jobs/retention      — purge old bot_logs (pure DB)
 *   /api/bot/jobs/missions-reset — clear children completed_items (pure DB)
 *   /api/bot/jobs/scheduled      — inactivity-triggered messages (sends, bounded)
 *   /api/bot/jobs/reminders      — game reminders   (extension point — needs game port)
 *   /api/bot/jobs/raffle         — daily raffle draw (extension point — needs game port)
 *
 * Behavioural verification pending (needs deploy + pg_cron wiring + test bot).
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../db";
import { resolveCreds, sendText, sendImage, type BotEnv, type BotCreds } from "./wa";
import { reportError, errInfo } from "./report-error";
import { sendScheduledReminders, executeRaffle, type GameBot } from "./game";
import { sendBaileysText, sendBaileysImage, toJid } from "./baileys";

const router = Router();
const LOG_RETENTION_DAYS = 90;
const SCHEDULED_MAX_PER_RUN = 50;

function secretOk(req: Request): boolean {
  const expected = process.env.SMRTBOT_INTERNAL_SECRET || process.env.CRON_SECRET || "";
  return !!expected && req.get("x-smrtbot-secret") === expected;
}

router.use("/api/bot/jobs", (req: Request, res: Response, next) => {
  if (!secretOk(req)) return res.status(401).json({ error: "unauthorized" });
  next();
});

// ── retention: purge bot_logs older than N days ─────────────────────────────
router.post("/api/bot/jobs/retention", async (_req: Request, res: Response) => {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400_000).toISOString();
  const { error, count } = await db
    .from("smrtbot_bot_logs")
    .delete({ count: "estimated" })
    .lt("created_at", cutoff);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, purged: count ?? null });
});

// ── daily missions reset: clear completed_items for all children ────────────
router.post("/api/bot/jobs/missions-reset", async (_req: Request, res: Response) => {
  const { error, count } = await db
    .from("smrtbot_children")
    .update({ completed_items: "" }, { count: "estimated" })
    .neq("completed_items", "");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, reset: count ?? null });
});

// ── inactivity-triggered scheduled messages (bounded sends) ─────────────────
interface SchedConfig {
  id: string;
  org_id: string;
  bot_id: string;
  inactivity_minutes: number;
  body_text: string;
  env: BotEnv;
}

router.post("/api/bot/jobs/scheduled", async (_req: Request, res: Response) => {
  const { data: configs, error } = await db
    .from("smrtbot_scheduled_configs")
    .select("id, org_id, bot_id, inactivity_minutes, body_text, env")
    .eq("active", true);
  if (error) return res.status(500).json({ error: error.message });

  let sent = 0;
  for (const cfg of (configs as SchedConfig[]) ?? []) {
    if (sent >= SCHEDULED_MAX_PER_RUN) break;
    if (!cfg.body_text?.trim()) continue;

    const { data: bot } = await db
      .from("smrtbot_bots")
      .select("test_wa_phone_number_id, test_wa_access_token, live_wa_phone_number_id, live_wa_access_token, wa_phone_number_id, wa_access_token")
      .eq("id", cfg.bot_id)
      .maybeSingle();
    const creds = bot ? resolveCreds(bot as BotCreds, cfg.env) : null;
    if (!creds) continue;

    const inactiveBefore = new Date(Date.now() - cfg.inactivity_minutes * 60_000).toISOString();
    const { data: users } = await db
      .from("smrtbot_wa_users")
      .select("phone, last_interaction_at")
      .eq("bot_id", cfg.bot_id)
      .eq("wa_opted_out", false)
      .lt("last_interaction_at", inactiveBefore)
      .limit(SCHEDULED_MAX_PER_RUN - sent);

    for (const u of (users as { phone: string }[]) ?? []) {
      // Skip if we already sent this config to this phone.
      const { data: already } = await db
        .from("smrtbot_scheduled_logs")
        .select("id")
        .eq("config_id", cfg.id)
        .eq("phone", u.phone)
        .maybeSingle();
      if (already) continue;

      try {
        await sendText(creds, u.phone, cfg.body_text);
        const { error: logErr } = await db.from("smrtbot_scheduled_logs").insert({
          org_id: cfg.org_id,
          bot_id: cfg.bot_id,
          config_id: cfg.id,
          phone: u.phone,
        });
        if (logErr) console.error("[smrtbot/jobs] scheduled log", logErr.message);
        sent++;
      } catch (e) {
        const { message: msg, stack } = errInfo(e);
        await reportError(cfg.org_id, {
          area: "cron",
          title: "Scheduled message send failed",
          message: msg,
          botId: cfg.bot_id,
          stack,
          details: { config_id: cfg.id, phone: u.phone, env: cfg.env },
        });
      }
      if (sent >= SCHEDULED_MAX_PER_RUN) break;
    }
  }
  res.json({ ok: true, sent });
});

const BOT_SELECT =
  "id, org_id, slug, public_phone_number, live_phone_display, wa_phone_number_id, wa_access_token, live_wa_phone_number_id, live_wa_access_token, test_wa_phone_number_id, test_wa_access_token";

// ── game daily reminders (hourly): match children whose reminder_time == now ─
router.post("/api/bot/jobs/reminders", async (_req: Request, res: Response) => {
  const { data: bots, error } = await db.from("smrtbot_bots").select(BOT_SELECT).eq("active", true);
  if (error) return res.status(500).json({ error: error.message });
  const ilHour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Jerusalem" }).format(new Date()),
  );
  const hourLabel = `${ilHour}:00`;
  let sent = 0;
  for (const bot of (bots as GameBot[]) ?? []) {
    try {
      sent += await sendScheduledReminders(bot, "live", hourLabel);
    } catch (e) {
      const { message, stack } = errInfo(e);
      await reportError(bot.org_id, { area: "cron", title: "Game reminders failed", message, botId: bot.id, stack });
    }
  }
  res.json({ ok: true, hour: hourLabel, sent });
});

// ── daily raffle draw: run today's pending raffles per bot ──────────────────
router.post("/api/bot/jobs/raffle", async (_req: Request, res: Response) => {
  const { data: bots, error } = await db.from("smrtbot_bots").select(BOT_SELECT).eq("active", true);
  if (error) return res.status(500).json({ error: error.message });
  const today = new Date().toISOString().slice(0, 10);
  let drawn = 0;
  for (const bot of (bots as GameBot[]) ?? []) {
    const { data: raffles } = await db
      .from("smrtbot_raffles")
      .select("raffle_type")
      .eq("bot_id", bot.id)
      .eq("raffle_date", today)
      .eq("status", "Pending");
    for (const r of (raffles ?? []) as { raffle_type: string }[]) {
      try {
        const winner = await executeRaffle(bot, "live", r.raffle_type);
        if (winner) drawn++;
      } catch (e) {
        const { message, stack } = errInfo(e);
        await reportError(bot.org_id, { area: "cron", title: "Raffle draw failed", message, botId: bot.id, stack, details: { raffle_type: r.raffle_type } });
      }
    }
  }
  res.json({ ok: true, drawn });
});

// ── scheduled broadcasts drain (every minute) ───────────────────────────────
// Sends each broadcast whose scheduled_at has passed, through the owning bot's
// transport (Baileys for the unofficial channel, Meta for the official one),
// then flips the row to sent/failed. Bounded per run.
interface BroadcastRow {
  id: string;
  org_id: string;
  bot_id: string;
  target_type: "group" | "phone";
  target_jid: string;
  body_text: string;
  media_url: string | null;
}

const BROADCASTS_MAX_PER_RUN = 50;

const BROADCAST_STUCK_MINUTES = 10;

router.post("/api/bot/jobs/broadcasts", async (_req: Request, res: Response) => {
  const now = new Date().toISOString();

  // Reap broadcasts orphaned in 'sending' (server crashed mid-send, or a status
  // write below failed) back to 'pending' so the next tick retries them —
  // otherwise the cron, which only picks 'pending', would never touch them again.
  const stuckCutoff = new Date(Date.now() - BROADCAST_STUCK_MINUTES * 60_000).toISOString();
  const { error: reapErr } = await db
    .from("smrtbot_scheduled_broadcasts")
    .update({ status: "pending" })
    .eq("status", "sending")
    .lt("updated_at", stuckCutoff);
  if (reapErr) console.error("[smrtbot/jobs] broadcast reap:", reapErr.message);

  const { data: due, error } = await db
    .from("smrtbot_scheduled_broadcasts")
    .select("id, org_id, bot_id, target_type, target_jid, body_text, media_url")
    .eq("status", "pending")
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .limit(BROADCASTS_MAX_PER_RUN);
  if (error) return res.status(500).json({ error: error.message });

  let sent = 0;
  let failed = 0;

  for (const b of (due as BroadcastRow[]) ?? []) {
    // Claim the row first so a slow send can't be double-dispatched by an
    // overlapping cron tick.
    const { data: claimed, error: claimErr } = await db
      .from("smrtbot_scheduled_broadcasts")
      .update({ status: "sending" })
      .eq("id", b.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr || !claimed) continue;

    try {
      const { data: bot } = await db
        .from("smrtbot_bots")
        .select(
          "id, transport, wa_phone_number_id, wa_access_token, live_wa_phone_number_id, live_wa_access_token, test_wa_phone_number_id, test_wa_access_token",
        )
        .eq("id", b.bot_id)
        .maybeSingle();
      if (!bot) throw new Error("bot not found");

      let result: { status: "sent" | "failed"; wa_message_id?: string | null; error?: string };

      if ((bot as { transport?: string }).transport === "baileys") {
        const jid = toJid(b.target_jid);
        result = b.media_url
          ? await sendBaileysImage(b.bot_id, jid, b.media_url, b.body_text || undefined)
          : await sendBaileysText(b.bot_id, jid, b.body_text);
      } else {
        // The official Meta Cloud API has no group send — `to` is a phone
        // number, not a group JID. Fail once, cleanly, rather than 100-erroring
        // against Meta every cron tick.
        if (b.target_type === "group") {
          throw new Error("meta transport cannot broadcast to a group");
        }
        const creds = resolveCreds(bot as BotCreds, "live");
        if (!creds) throw new Error("bot has no live WhatsApp credentials");
        const out = b.media_url
          ? await sendImage(creds, b.target_jid, b.media_url, b.body_text || undefined)
          : await sendText(creds, b.target_jid, b.body_text);
        result = { status: "sent", wa_message_id: out.wa_message_id };
      }

      if (result.status === "sent") {
        const { error: upErr } = await db
          .from("smrtbot_scheduled_broadcasts")
          .update({ status: "sent", sent_at: new Date().toISOString(), wa_message_id: result.wa_message_id ?? null, error: null })
          .eq("id", b.id);
        if (upErr) console.error("[smrtbot/jobs] mark sent:", b.id, upErr.message);
        sent++;
      } else {
        const { error: upErr } = await db
          .from("smrtbot_scheduled_broadcasts")
          .update({ status: "failed", error: result.error ?? "send failed" })
          .eq("id", b.id);
        if (upErr) console.error("[smrtbot/jobs] mark failed:", b.id, upErr.message);
        failed++;
        await reportError(b.org_id, {
          area: "cron",
          title: "Scheduled broadcast send failed",
          message: result.error ?? "send failed",
          botId: b.bot_id,
          details: { broadcast_id: b.id, target: b.target_jid },
        });
      }
    } catch (e) {
      const { message, stack } = errInfo(e);
      await db
        .from("smrtbot_scheduled_broadcasts")
        .update({ status: "failed", error: message })
        .eq("id", b.id);
      failed++;
      await reportError(b.org_id, {
        area: "cron",
        title: "Scheduled broadcast send failed",
        message,
        botId: b.bot_id,
        stack,
        details: { broadcast_id: b.id, target: b.target_jid },
      });
    }
  }

  res.json({ ok: true, sent, failed });
});

export default router;
