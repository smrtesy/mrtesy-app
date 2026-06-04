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
import { resolveCreds, sendText, type BotEnv, type BotCreds } from "./wa";
import { reportError, errInfo } from "./report-error";

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

// ── game reminders + raffle draw — extension points (need game.js port) ─────
router.post("/api/bot/jobs/reminders", async (_req: Request, res: Response) => {
  res.json({ ok: true, note: "reminders job — implemented with the game port (2ד)" });
});

router.post("/api/bot/jobs/raffle", async (_req: Request, res: Response) => {
  res.json({ ok: true, note: "raffle draw job — implemented with the game port (2ד)" });
});

export default router;
