/**
 * דוח יומי — weekly report cron job (x-cron-secret gated, no JWT).
 *
 * POST /api/daily-report/jobs/weekly — called hourly by pg_cron
 * (supabase/migrations/20260720120100_daily_report_cron.sql). For every user
 * who has the day-tool enabled it delivers the weekly report to the smrtTask
 * inbox WHEN it is Tuesday at the user's configured hour in THEIR timezone
 * (America/New_York by default) and this week's report hasn't been sent yet.
 *
 * Mounted in server/index.ts BEFORE the auth guards, like the smrtbot/smrtplan
 * job routers.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { generateAndDeliver, periodRange, ymdInTz, localWeekdayHour, DEFAULT_TZ, type PeriodType } from "./report";

const router = Router();

const DELIVERY_WEEKDAY = "Tue"; // per the product decision: reports arrive Tuesday
const DEFAULT_HOUR = 8;         // 08:00 in the user's timezone
const MAX_USERS = 500;

interface SettingsRow {
  user_id: string;
  timezone: string | null;
  day_tools: Record<string, { enabled?: boolean; report_hour?: number; period?: string }> | null;
}

/** Resolve a user's primary org, only if smrttask is entitled for it. */
async function entitledOrg(userId: string): Promise<string | null> {
  const { data: membership } = await db
    .from("org_members")
    .select("org_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return null;
  const orgId = membership.org_id as string;

  const { data: app } = await db.from("apps").select("id").eq("slug", "smrttask").maybeSingle();
  const { data: entitled } = await db
    .from("app_memberships")
    .select("org_id")
    .eq("org_id", orgId)
    .eq("app_id", app?.id ?? "")
    .maybeSingle();
  return entitled ? orgId : null;
}

router.post("/api/daily-report/jobs/weekly", async (req: Request, res: Response) => {
  const expected = process.env.CRON_SECRET || process.env.SMRTBOT_INTERNAL_SECRET;
  if (!expected || req.headers["x-cron-secret"] !== expected) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const now = new Date();
  const { data: rows, error } = await db
    .from("user_settings")
    .select("user_id, timezone, day_tools")
    .not("day_tools", "is", null)
    .limit(MAX_USERS);
  if (error) return res.status(500).json({ error: error.message });

  let delivered = 0;
  const ran: string[] = [];
  for (const row of (rows as SettingsRow[] | null) ?? []) {
    const cfg = row.day_tools?.dailyreport;
    if (!cfg || cfg.enabled !== true) continue;

    const tz = row.timezone?.trim() || DEFAULT_TZ;
    const targetHour = typeof cfg.report_hour === "number" ? cfg.report_hour : DEFAULT_HOUR;
    const period: PeriodType = cfg.period === "monthly" ? "monthly" : "weekly";
    const { weekday, hour, day } = localWeekdayHour(now, tz);

    // Reports arrive on Tuesday. Fire at the first hourly run AT OR AFTER the
    // target hour (so a missed exact hour or a DST-gap hour still delivers that
    // day; the once-per-period guard below prevents a repeat). Monthly delivers
    // only on the FIRST Tuesday of the month (day-of-month 1–7).
    if (weekday !== DELIVERY_WEEKDAY || hour < targetHour) continue;
    if (period === "monthly" && day > 7) continue;
    const today = ymdInTz(now, tz);
    const { start, end } = periodRange(period, today);

    // Once-per-week guard: skip if a scheduled run already exists for this range.
    const { data: prior } = await db
      .from("daily_report_runs")
      .select("id")
      .eq("user_id", row.user_id)
      .eq("generated_by", "schedule")
      .eq("range_start", start)
      .limit(1)
      .maybeSingle();
    if (prior) continue;

    const orgId = await entitledOrg(row.user_id);
    if (!orgId) continue;

    try {
      await generateAndDeliver(row.user_id, orgId, tz, period, start, end, "schedule");
      delivered++;
      ran.push(row.user_id);
    } catch (e) {
      console.error("[daily-report/jobs] delivery failed", row.user_id, e instanceof Error ? e.message : e);
    }
  }

  res.json({ ok: true, delivered, users: ran });
});

export default router;
