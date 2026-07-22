/**
 * דוח יומי — authenticated API for the daily-report day-tool.
 *
 *   GET  /daily-report/config          the question set (items + options + segment + weekdays)
 *   PUT  /daily-report/config          replace the question set (archives removed)
 *   GET  /daily-report/checkin?fillDate=  the two-section check-in for a fill date
 *   PUT  /daily-report/checkin          save answers (each carries its own entry_date)
 *   GET  /daily-report/pending         incomplete fill-dates in the recent window
 *   POST /daily-report/generate        generate + deliver a report now → { report }
 *   GET  /daily-report/preview?period= compute a report without delivering
 *   GET  /daily-report/runs            recent generated reports
 *
 * Two-day model: a question's `segment` decides which calendar day its answer
 * belongs to. Filling on day F, an 'end' question closes F−1 (stored with
 * entry_date=F−1) and a 'start' question opens F (entry_date=F). A question's
 * `weekdays` restricts it to certain weekdays OF THE DAY IT BELONGS TO.
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
  addDays,
  DEFAULT_TZ,
  type PeriodType,
} from "./report";
import { weekdayNum } from "./hebdate";

const router = Router();
router.use(requireAuth, requireOrg, requireApp("smrttask"), requireFullTask);

const MAX_LABEL = 200;
const MAX_ITEMS = 100;
const MAX_OPTIONS = 40;
const MISSED_LOOKBACK_DAYS = 14; // how far back incomplete fill-days surface

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
function parseSegment(v: unknown): "start" | "end" {
  return v === "end" ? "end" : "start";
}
/** Normalize weekdays input → sorted unique 0–6 array, or null (= every day). */
function parseWeekdays(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const set = new Set<number>();
  for (const x of v) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  if (set.size === 0 || set.size === 7) return null; // empty or all → "every day"
  return [...set].sort((a, b) => a - b);
}
/** Does a question (weekdays possibly null) apply on the given calendar date? */
function appliesOn(weekdays: number[] | null, ymd: string): boolean {
  if (!weekdays || weekdays.length === 0) return true;
  return weekdays.includes(weekdayNum(ymd));
}

// ── config (questions + options + segment + weekdays) ────────────────────────

router.get("/daily-report/config", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const { data: items, error } = await db
    .from("daily_report_items")
    .select("id, label, position, active, segment, weekdays")
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
    segment: it.segment ?? "start",
    weekdays: it.weekdays ?? null,
    options: byItem.get(it.id) ?? [],
  }));
  res.json({ items: result });
});

interface OptionInput { id?: string; label: string; score?: unknown }
interface ItemInput { id?: string; label: string; segment?: unknown; weekdays?: unknown; options?: OptionInput[] }

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
    const segment = parseSegment(raw.segment);
    const weekdays = parseWeekdays(raw.weekdays);
    const opts = (Array.isArray(raw.options) ? raw.options : []).slice(0, MAX_OPTIONS);

    let itemId = typeof raw.id === "string" && existingIds.has(raw.id) ? raw.id : null;
    if (itemId) {
      const { error } = await db
        .from("daily_report_items")
        .update({ label, position: i, active: true, segment, weekdays, updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("id", itemId);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      const { data: created, error } = await db
        .from("daily_report_items")
        .insert({ user_id: userId, org_id: orgId, label, position: i, active: true, segment, weekdays })
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

// ── check-in (two sections keyed by fill date) ───────────────────────────────

interface ActiveItem { id: string; label: string; segment: string; weekdays: number[] | null }
interface OptionLite { id: string; item_id: string; label: string; score: number | null; position: number }

/** Load the caller's active questions + their options. `error` set on failure
 *  so callers can 500 instead of silently treating a DB error as "no data". */
async function loadActive(userId: string): Promise<{ items: ActiveItem[]; optsByItem: Map<string, OptionLite[]>; error: string | null }> {
  const { data: items, error: itemsErr } = await db
    .from("daily_report_items")
    .select("id, label, segment, weekdays, position")
    .eq("user_id", userId)
    .eq("active", true)
    .order("position", { ascending: true });
  const { data: options, error: optsErr } = await db
    .from("daily_report_options")
    .select("id, item_id, label, score, position")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  const err = itemsErr?.message ?? optsErr?.message ?? null;
  const optsByItem = new Map<string, OptionLite[]>();
  for (const o of (options as OptionLite[] | null) ?? []) {
    const arr = optsByItem.get(o.item_id) ?? [];
    arr.push(o);
    optsByItem.set(o.item_id, arr);
  }
  const list = ((items as { id: string; label: string; segment: string | null; weekdays: number[] | null }[] | null) ?? [])
    .map((it) => ({ id: it.id, label: it.label, segment: it.segment ?? "start", weekdays: it.weekdays ?? null }));
  return { items: list, optsByItem, error: err };
}

/** The items due for a given fill date, split into the two sections. */
function dueSections(items: ActiveItem[], fillDate: string): {
  end: { entry_date: string; items: ActiveItem[] };
  start: { entry_date: string; items: ActiveItem[] };
} {
  const yesterday = addDays(fillDate, -1);
  const end = items.filter((it) => it.segment === "end" && appliesOn(it.weekdays, yesterday));
  const start = items.filter((it) => it.segment === "start" && appliesOn(it.weekdays, fillDate));
  return {
    end: { entry_date: yesterday, items: end },
    start: { entry_date: fillDate, items: start },
  };
}

router.get("/daily-report/checkin", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const tz = await userTz(userId);
  const fillDate = typeof req.query.fillDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fillDate)
    ? req.query.fillDate
    : ymdInTz(new Date(), tz);

  const { items, optsByItem, error: loadErr } = await loadActive(userId);
  if (loadErr) return res.status(500).json({ error: loadErr });
  const sec = dueSections(items, fillDate);
  const entryDates = [sec.end.entry_date, sec.start.entry_date];

  // Saved answers for the two entry-dates this fill covers.
  const { data: entries, error: entriesErr } = await db
    .from("daily_report_entries")
    .select("entry_date, item_id, option_id")
    .eq("user_id", userId)
    .in("entry_date", entryDates);
  if (entriesErr) return res.status(500).json({ error: entriesErr.message });
  const savedByKey = new Map<string, string | null>();
  for (const e of (entries as { entry_date: string; item_id: string; option_id: string | null }[] | null) ?? []) {
    savedByKey.set(`${e.entry_date}:${e.item_id}`, e.option_id);
  }

  const buildSection = (segment: "end" | "start", entry_date: string, secItems: ActiveItem[]) => ({
    segment,
    entry_date,
    items: secItems.map((it) => ({
      id: it.id,
      label: it.label,
      options: (optsByItem.get(it.id) ?? []).map((o) => ({ id: o.id, label: o.label, score: o.score })),
      selected_option_id: savedByKey.get(`${entry_date}:${it.id}`) ?? null,
    })),
  });

  const sections = [
    buildSection("end", sec.end.entry_date, sec.end.items),
    buildSection("start", sec.start.entry_date, sec.start.items),
  ].filter((s) => s.items.length > 0);

  const totalDue = sec.end.items.length + sec.start.items.length;
  const answered = sections.reduce(
    (n, s) => n + s.items.filter((i) => i.selected_option_id).length,
    0,
  );
  const done = totalDue === 0 || answered >= totalDue;

  res.json({ fill_date: fillDate, sections, done, total_due: totalDue, answered });
});

interface AnswerInput { item_id: string; option_id: string; entry_date: string }

router.put("/daily-report/checkin", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.org!.id;
  const answers = Array.isArray(req.body?.answers) ? (req.body.answers as AnswerInput[]) : [];

  for (const a of answers) {
    if (typeof a.item_id !== "string" || typeof a.option_id !== "string") continue;
    if (typeof a.entry_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.entry_date)) continue;
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
          entry_date: a.entry_date,
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

  res.json({ ok: true });
});

/**
 * Incomplete fill-days in the recent window, newest first. A fill-day surfaces
 * as a pinned row so the user can back-fill it.
 *
 * Missed days count only from the moment the user actually engaged: the window
 * spans the last MISSED_LOOKBACK_DAYS, but we drop everything older than the
 * earliest fill-day that has any answer. So a fresh setup (no answers yet) shows
 * only today, and the day-before-first-fill ghost (an 'end' answer stores
 * entry_date=fill−1, which would otherwise anchor one day too early) never
 * surfaces. Today is always shown when it is still incomplete.
 */
router.get("/daily-report/pending", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const tz = await userTz(userId);
  const today = ymdInTz(new Date(), tz);

  const { items, error: loadErr } = await loadActive(userId);
  if (loadErr) return res.status(500).json({ error: loadErr });
  if (items.length === 0) return res.json({ today, days: [] });

  const floor = addDays(today, -(MISSED_LOOKBACK_DAYS - 1));

  // All answers in the covered range (floor−1 .. today), one query.
  const { data: entries, error: entriesErr } = await db
    .from("daily_report_entries")
    .select("entry_date, item_id, option_id")
    .eq("user_id", userId)
    .gte("entry_date", addDays(floor, -1))
    .lte("entry_date", today);
  if (entriesErr) return res.status(500).json({ error: entriesErr.message });
  const answeredSet = new Set<string>();
  for (const e of (entries as { entry_date: string; item_id: string; option_id: string | null }[] | null) ?? []) {
    if (e.option_id) answeredSet.add(`${e.entry_date}:${e.item_id}`);
  }

  // Enumerate fill-days floor..today (newest first) with their due/answered counts.
  const isAnswered = (entry_date: string, id: string) => answeredSet.has(`${entry_date}:${id}`);
  type Row = { fill_date: string; total_due: number; answered: number; is_today: boolean };
  const rows: Row[] = [];
  let earliestEngaged: string | null = null; // oldest fill-day with any answer
  for (let F = today; F >= floor; F = addDays(F, -1)) {
    const sec = dueSections(items, F);
    const due = [
      ...sec.end.items.map((it) => ({ entry_date: sec.end.entry_date, id: it.id })),
      ...sec.start.items.map((it) => ({ entry_date: sec.start.entry_date, id: it.id })),
    ];
    if (due.length === 0) continue; // nothing was ever due this fill-day
    const answered = due.filter((d) => isAnswered(d.entry_date, d.id)).length;
    if (answered > 0) earliestEngaged = F; // keeps moving back as we go older
    if (answered >= due.length) continue; // fully filled → not pending
    rows.push({ fill_date: F, total_due: due.length, answered, is_today: F === today });
  }

  // Keep today (if pending) + any incomplete day at/after the first engaged day.
  const days = rows.filter((r) => r.is_today || (earliestEngaged != null && r.fill_date >= earliestEngaged));

  res.json({ today, days });
});

// ── generate now + preview + history ─────────────────────────────────────────

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

/** Preview (compute without delivering) — used by the report view screen. */
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
