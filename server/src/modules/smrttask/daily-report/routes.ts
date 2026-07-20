/**
 * דוח יומי — authenticated API for the daily-report day-tool.
 *
 *   GET  /daily-report/config          the question set (items + options)
 *   PUT  /daily-report/config          replace the question set (archives removed)
 *   GET  /daily-report/today?date=     today's answers + whether the day is done
 *   PUT  /daily-report/today           save today's answers (snapshots score+label)
 *   POST /daily-report/generate        generate + deliver a report now → { report }
 *   GET  /daily-report/runs            recent generated reports
 *
 * All personal (user-scoped within the org). See docs/daily-report-plan.md.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth, requireOrg, requireApp } from "../../../middleware";
import { requireFullTask } from "../lib/access";
import {
  computeReport,
  generateAndDeliver,
  periodRange,
  ymdInTz,
  DEFAULT_TZ,
  type PeriodType,
} from "./report";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

const MAX_LABEL = 200;
const MAX_ITEMS = 100;
const MAX_OPTIONS = 40;

/** The caller's display timezone (defaults to New York). */
async function userTz(userId: string): Promise<string> {
  const { data } = await db
    .from("user_settings")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  const tz = (data?.timezone as string | null)?.trim();
  return tz || DEFAULT_TZ;
}

function clampLabel(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_LABEL) : "";
}
function parseScore(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── config (questions + options) ────────────────────────────────────────────

router.get("/daily-report/config", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { data: items, error } = await db
    .from("daily_report_items")
    .select("id, label, position, active")
    .eq("user_id", userId)
    .eq("active", true)
    .order("position", { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  const { data: options, error: oErr } = await db
    .from("daily_report_options")
    .select("id, item_id, label, score, position")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (oErr) return res.status(500).json({ error: oErr.message });

  const byItem = new Map<string, unknown[]>();
  for (const o of options ?? []) {
    const arr = byItem.get(o.item_id) ?? [];
    arr.push({ id: o.id, label: o.label, score: o.score, position: o.position });
    byItem.set(o.item_id, arr);
  }
  const result = (items ?? []).map((it) => ({
    id: it.id,
    label: it.label,
    position: it.position,
    options: byItem.get(it.id) ?? [],
  }));
  res.json({ items: result });
});

interface OptionInput { id?: string; label: string; score?: unknown }
interface ItemInput { id?: string; label: string; options?: OptionInput[] }

router.put("/daily-report/config", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.org!.id;
  const rawItems = Array.isArray(req.body?.items) ? (req.body.items as ItemInput[]) : null;
  if (!rawItems) return res.status(400).json({ error: "items array required" });
  if (rawItems.length > MAX_ITEMS) return res.status(400).json({ error: "too many items" });

  // Existing active items — anything not present in the payload gets archived
  // (never hard-deleted, so past runs stay reconstructable).
  const { data: existing } = await db
    .from("daily_report_items")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true);
  const existingIds = new Set((existing ?? []).map((r) => r.id as string));
  const keptIds = new Set<string>();

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const label = clampLabel(raw.label);
    if (!label) continue;
    const opts = (Array.isArray(raw.options) ? raw.options : []).slice(0, MAX_OPTIONS);

    let itemId = typeof raw.id === "string" && existingIds.has(raw.id) ? raw.id : null;
    if (itemId) {
      const { error } = await db
        .from("daily_report_items")
        .update({ label, position: i, active: true, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("id", itemId);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { data: created, error } = await db
        .from("daily_report_items")
        .insert({ user_id: userId, org_id: orgId, label, position: i, active: true })
        .select("id")
        .single();
      if (error) return res.status(500).json({ error: error.message });
      itemId = created.id as string;
    }
    keptIds.add(itemId);

    // Replace this item's options wholesale. Entries snapshot label+score, so
    // deleting an option only nulls entries.option_id — history is preserved.
    const { error: delErr } = await db
      .from("daily_report_options")
      .delete()
      .eq("user_id", userId)
      .eq("item_id", itemId);
    if (delErr) return res.status(500).json({ error: delErr.message });

    const rows = opts
      .map((o, j) => ({
        item_id: itemId as string,
        user_id: userId,
        org_id: orgId,
        label: clampLabel(o.label),
        score: parseScore(o.score),
        position: j,
      }))
      .filter((r) => r.label);
    if (rows.length) {
      const { error: insErr } = await db.from("daily_report_options").insert(rows);
      if (insErr) return res.status(500).json({ error: insErr.message });
    }
  }

  // Archive items that were removed from the payload.
  const toArchive = [...existingIds].filter((id) => !keptIds.has(id));
  if (toArchive.length) {
    const { error } = await db
      .from("daily_report_items")
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .in("id", toArchive);
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true });
});

// ── daily answers ────────────────────────────────────────────────────────────

router.get("/daily-report/today", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const tz = await userTz(userId);
  const date = typeof req.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : ymdInTz(new Date(), tz);

  const { data: activeItems } = await db
    .from("daily_report_items")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true);
  const activeIds = new Set((activeItems ?? []).map((r) => r.id as string));

  const { data: entries, error } = await db
    .from("daily_report_entries")
    .select("item_id, option_id, option_label, score_snapshot")
    .eq("user_id", userId)
    .eq("entry_date", date);
  if (error) return res.status(500).json({ error: error.message });

  const map: Record<string, { option_id: string | null; option_label: string; score: number | null }> = {};
  for (const e of entries ?? []) {
    map[e.item_id] = { option_id: e.option_id, option_label: e.option_label, score: e.score_snapshot };
  }
  const answeredActive = [...activeIds].filter((id) => map[id]).length;
  // No active questions → nothing to fill, so the day is "done" (the pinned
  // row must not nag forever when the tool is on but empty).
  const done = activeIds.size === 0 || answeredActive >= activeIds.size;

  res.json({ date, entries: map, done, active_count: activeIds.size });
});

interface AnswerInput { item_id: string; option_id: string }

router.put("/daily-report/today", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.org!.id;
  const tz = await userTz(userId);
  const date = typeof req.body?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
    ? req.body.date
    : ymdInTz(new Date(), tz);
  const answers = Array.isArray(req.body?.answers) ? (req.body.answers as AnswerInput[]) : [];

  for (const a of answers) {
    if (typeof a.item_id !== "string" || typeof a.option_id !== "string") continue;
    // Resolve the chosen option (must belong to the caller + item) to snapshot
    // its label + score at answer time.
    const { data: opt } = await db
      .from("daily_report_options")
      .select("label, score")
      .eq("user_id", userId)
      .eq("item_id", a.item_id)
      .eq("id", a.option_id)
      .maybeSingle();
    if (!opt) continue;

    const { error } = await db
      .from("daily_report_entries")
      .upsert(
        {
          user_id: userId,
          org_id: orgId,
          entry_date: date,
          item_id: a.item_id,
          option_id: a.option_id,
          option_label: opt.label,
          score_snapshot: opt.score,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,entry_date,item_id" },
      );
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ ok: true, date });
});

// ── generate now + history ────────────────────────────────────────────────

router.post("/daily-report/generate", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.org!.id;
  const tz = await userTz(userId);
  const period: PeriodType = req.body?.period === "monthly" ? "monthly" : "weekly";
  const today = ymdInTz(new Date(), tz);
  const { start, end } = periodRange(period, today);

  try {
    const result = await generateAndDeliver(userId, orgId, tz, period, start, end, "manual");
    res.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: message });
  }
});

/** Preview (compute without delivering) — used by the settings "try it" view. */
router.get("/daily-report/preview", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const tz = await userTz(userId);
  const period: PeriodType = req.query.period === "monthly" ? "monthly" : "weekly";
  const today = ymdInTz(new Date(), tz);
  const { start, end } = periodRange(period, today);
  const report = await computeReport(userId, tz, period, start, end);
  res.json({ report });
});

router.get("/daily-report/runs", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { data, error } = await db
    .from("daily_report_runs")
    .select("id, period_type, range_start, range_end, overall_score, breakdown, generated_by, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ runs: data });
});

export default router;
