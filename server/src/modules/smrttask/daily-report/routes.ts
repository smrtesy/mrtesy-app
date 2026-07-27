/**
 * דוח יומי — authenticated API for the daily-report day-tool.
 *
 *   GET  /daily-report/config          the question set (items + options + segment + weekdays)
 *   PUT  /daily-report/config          replace the question set (archives removed)
 *   GET  /daily-report/checkin?fillDate=  the two-section check-in for a fill date
 *   PUT  /daily-report/checkin          save answers (each carries its own entry_date)
 *   GET  /daily-report/pending         incomplete fill-dates in the recent window
 *   GET  /daily-report/days?limit=     recent fill-dates with their fill status
 *                                      (all of them — powers editing a past day)
 *   POST /daily-report/generate        generate + deliver a report now → { report }
 *   GET  /daily-report/preview?period= compute a report without delivering
 *   GET  /daily-report/runs            recent generated reports
 *
 * Two-day model: a question's `segment` decides which calendar day its answer
 * belongs to. Filling on day F, an 'end' question closes F−1 (stored with
 * entry_date=F−1) and a 'start' question opens F (entry_date=F). A question's
 * `weekdays` restricts it to certain weekdays OF THE DAY IT BELONGS TO, and a
 * question is never due before the day it was created (see `dueOn`).
 *
 * All personal (user-scoped within the org). See docs/daily-report-plan.md.
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
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
const EDIT_WINDOW_DAYS = 60;     // how far back a past fill-day may be edited
const DEFAULT_DAYS_LIMIT = 14;   // default span of GET /daily-report/days

/** The caller's display timezone (defaults to New York). */
async function userTz(userId: string): Promise<string> {
  const { data, error } = await db
    .from("user_settings")
    .select("timezone")
    .eq("user_id", userId)
    .maybeSingle();
  // A transient failure silently falls back to New York. Not fatal (both sides of
  // every date comparison use the same tz), but it must not be invisible.
  if (error) console.warn("[daily-report] timezone lookup failed:", error.message);
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
/** Oldest fill-day that may still be opened/edited (inclusive). */
function oldestFillDate(today: string): string {
  return addDays(today, -(EDIT_WINDOW_DAYS - 1));
}
/** Oldest entry_date a save may touch: the 'end' section of the oldest fill-day
 *  belongs to the day BEFORE it, so the entry window is one day wider. */
function oldestEntryDate(today: string): string {
  return addDays(today, -EDIT_WINDOW_DAYS);
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
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
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
  // A swallowed error here would be silently destructive: an empty existingIds
  // makes every payload item look new, so the whole question set is re-inserted
  // as duplicates while the originals are never archived.
  const { data: existing, error: existingErr } = await db
    .from("daily_report_items")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true);
  if (existingErr) return res.status(500).json({ error: existingErr.message });
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

    // Reconcile this item's options IN PLACE — update the ones the payload still
    // carries an id for, insert the new ones, delete only what was removed.
    //
    // This used to delete every option and re-insert it, which nulled
    // entries.option_id on ALL history (ON DELETE SET NULL) on every settings
    // save. Entries do snapshot label + score, so the report stayed correct, but
    // an answer that lost its option_id could no longer be pre-selected in the
    // check-in, and anything testing option_id read the day as never filled.
    const { data: existingOpts, error: exOptErr } = await db
      .from("daily_report_options")
      .select("id")
      .eq("user_id", userId)
      .eq("item_id", itemId);
    if (exOptErr) return res.status(500).json({ error: exOptErr.message });
    const existingOptIds = new Set((existingOpts ?? []).map((r) => r.id as string));
    const keptOptIds = new Set<string>();

    // Every row gets an explicit id — a kept one keeps its own (so entries stay
    // linked), a new one gets a fresh uuid — which lets the whole set go in a
    // SINGLE upsert. Two statements per item instead of 1+N means a failure can't
    // leave the item holding both the removed and the new options (which would
    // render duplicate answer buttons and double-count in the report).
    // A repeated id is treated as a NEW row: passing the same id twice in one
    // upsert is a Postgres error ("cannot affect row a second time").
    const rows = opts
      .map((o) => ({ id: typeof o.id === "string" ? o.id : null, label: clampLabel(o.label), score: parseScore(o.score) }))
      .filter((r) => r.label)
      .map((r, j) => {
        const reuse = r.id && existingOptIds.has(r.id) && !keptOptIds.has(r.id) ? r.id : null;
        if (reuse) keptOptIds.add(reuse);
        return {
          id: reuse ?? randomUUID(),
          item_id: itemId as string,
          user_id: userId,
          org_id: orgId,
          label: r.label,
          score: r.score,
          position: j,
        };
      });

    if (rows.length) {
      const { error: upErr } = await db
        .from("daily_report_options")
        .upsert(rows, { onConflict: "id" });
      if (upErr) return res.status(500).json({ error: upErr.message });
    }

    // Only options the user actually removed get deleted (their entries keep the
    // label + score snapshot and simply lose the pointer).
    const staleOptIds = [...existingOptIds].filter((id) => !keptOptIds.has(id));
    if (staleOptIds.length) {
      const { error: delErr } = await db
        .from("daily_report_options")
        .delete()
        .eq("user_id", userId)
        .eq("item_id", itemId)
        .in("id", staleOptIds);
      if (delErr) return res.status(500).json({ error: delErr.message });
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

interface ActiveItem {
  id: string;
  label: string;
  segment: string;
  weekdays: number[] | null;
  /** The question's creation date in the caller's tz — it is not due before it. */
  created_ymd: string;
}
interface OptionLite { id: string; item_id: string; label: string; score: number | null; position: number }

/** Load the caller's active questions + their options. `error` set on failure
 *  so callers can 500 instead of silently treating a DB error as "no data". */
async function loadActive(userId: string, tz: string): Promise<{ items: ActiveItem[]; optsByItem: Map<string, OptionLite[]>; error: string | null }> {
  const { data: items, error: itemsErr } = await db
    .from("daily_report_items")
    .select("id, label, segment, weekdays, position, created_at")
    .eq("user_id", userId)
    .eq("active", true)
    .order("position", { ascending: true });
  // created_at is the tie-break so two options sharing a position resolve in a
  // stable order — the label fallback below and the repair migration must agree
  // on WHICH option a duplicate label maps to.
  const { data: options, error: optsErr } = await db
    .from("daily_report_options")
    .select("id, item_id, label, score, position")
    .eq("user_id", userId)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  const err = itemsErr?.message ?? optsErr?.message ?? null;
  const optsByItem = new Map<string, OptionLite[]>();
  for (const o of (options as OptionLite[] | null) ?? []) {
    const arr = optsByItem.get(o.item_id) ?? [];
    arr.push(o);
    optsByItem.set(o.item_id, arr);
  }
  const list = ((items as { id: string; label: string; segment: string | null; weekdays: number[] | null; created_at: string }[] | null) ?? [])
    .map((it) => {
      // created_at is NOT NULL in the schema, but Intl.DateTimeFormat THROWS on
      // an invalid date and Express 4 does not route an async throw to the error
      // middleware — the request would hang instead of 500ing. Fall back to the
      // epoch, i.e. "always due", which is the safe direction.
      const created = it.created_at ? new Date(it.created_at) : null;
      return {
        id: it.id,
        label: it.label,
        segment: it.segment ?? "start",
        weekdays: it.weekdays ?? null,
        created_ymd: created && !Number.isNaN(created.getTime()) ? ymdInTz(created, tz) : "1970-01-01",
      };
    });
  return { items: list, optsByItem, error: err };
}

/**
 * Could this question have been asked on a given FILL-DAY? A question is not due
 * on a fill-day earlier than the day it was created.
 *
 * This gate exists because "due" is computed from the question set as it stands
 * NOW, against historical days. Without it, adding a question makes every past
 * day retroactively incomplete — the day pins as "missed" for a question that
 * did not exist then, and the user cannot possibly clear it (real case,
 * 2026-07-27: one question added that morning re-opened four days the user had
 * actually filled).
 *
 * The gate is on the FILL-DAY, not on the answer's entry_date. An 'end' question
 * stores entry_date = fillDate−1, so gating on entry_date would delay a new
 * question's first appearance by a day — and on setup day it would leave a
 * question set made only of 'end' questions with NOTHING due, which reads as
 * "no questions configured" and makes the tool look broken on day one.
 */
function dueOnFillDay(item: ActiveItem, fillDate: string, belongsTo: string): boolean {
  return fillDate >= item.created_ymd && appliesOn(item.weekdays, belongsTo);
}

/** The items due for a given fill date, split into the two sections. */
function dueSections(items: ActiveItem[], fillDate: string): {
  end: { entry_date: string; items: ActiveItem[] };
  start: { entry_date: string; items: ActiveItem[] };
} {
  const yesterday = addDays(fillDate, -1);
  const end = items.filter((it) => it.segment === "end" && dueOnFillDay(it, fillDate, yesterday));
  const start = items.filter((it) => it.segment === "start" && dueOnFillDay(it, fillDate, fillDate));
  return {
    end: { entry_date: yesterday, items: end },
    start: { entry_date: fillDate, items: start },
  };
}

router.get("/daily-report/checkin", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const tz = await userTz(userId);
  const today = ymdInTz(new Date(), tz);
  const fillDate = typeof req.query.fillDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.fillDate)
    ? req.query.fillDate
    : today;
  // A past day may be opened for editing, but only inside the edit window (and
  // never a future day) — the same bounds PUT enforces, so the check-in screen
  // can never offer a day whose save would be rejected.
  if (fillDate > today || fillDate < oldestFillDate(today)) {
    return res.status(400).json({ error: "fillDate outside the edit window" });
  }

  const { items, optsByItem, error: loadErr } = await loadActive(userId, tz);
  if (loadErr) return res.status(500).json({ error: loadErr });
  const sec = dueSections(items, fillDate);
  const entryDates = [sec.end.entry_date, sec.start.entry_date];

  // Saved answers for the two entry-dates this fill covers. option_label comes
  // along because option_id is NOT a reliable handle on the answer: editing the
  // question set replaces the option rows, and the FK nulls option_id on every
  // historical entry (ON DELETE SET NULL). The label snapshot is the durable
  // record, so we fall back to it to re-select the answer.
  const { data: entries, error: entriesErr } = await db
    .from("daily_report_entries")
    .select("entry_date, item_id, option_id, option_label")
    .eq("user_id", userId)
    .in("entry_date", entryDates);
  if (entriesErr) return res.status(500).json({ error: entriesErr.message });
  type SavedEntry = { option_id: string | null; option_label: string };
  const savedByKey = new Map<string, SavedEntry>();
  for (const e of (entries as { entry_date: string; item_id: string; option_id: string | null; option_label: string }[] | null) ?? []) {
    savedByKey.set(`${e.entry_date}:${e.item_id}`, { option_id: e.option_id, option_label: e.option_label });
  }

  const buildSection = (segment: "end" | "start", entry_date: string, secItems: ActiveItem[]) => ({
    segment,
    entry_date,
    items: secItems.map((it) => {
      const opts = optsByItem.get(it.id) ?? [];
      const saved = savedByKey.get(`${entry_date}:${it.id}`);
      // Prefer the live id; if it was nulled by an option rewrite, re-resolve by
      // the snapshotted label so the user's own answer is still pre-selected.
      const selected =
        saved?.option_id ?? (saved ? opts.find((o) => o.label === saved.option_label)?.id ?? null : null);
      return {
        id: it.id,
        label: it.label,
        options: opts.map((o) => ({ id: o.id, label: o.label, score: o.score })),
        selected_option_id: selected,
      };
    }),
  });

  const sections = [
    buildSection("end", sec.end.entry_date, sec.end.items),
    buildSection("start", sec.start.entry_date, sec.start.items),
  ].filter((s) => s.items.length > 0);

  const totalDue = sec.end.items.length + sec.start.items.length;
  // An answer counts as given when its entry row exists — same rule /pending and
  // /days use, so a day never reads "filled" in one place and "missed" in another.
  const answered = [sec.end, sec.start].reduce(
    (n, s) => n + s.items.filter((it) => savedByKey.has(`${s.entry_date}:${it.id}`)).length,
    0,
  );
  const done = totalDue === 0 || answered >= totalDue;

  res.json({ fill_date: fillDate, sections, done, total_due: totalDue, answered });
});

interface AnswerInput { item_id: string; option_id: string; entry_date: string }

router.put("/daily-report/checkin", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const orgId = req.org!.id;
  const tz = await userTz(userId);
  const today = ymdInTz(new Date(), tz);
  const oldest = oldestEntryDate(today);
  const answers = Array.isArray(req.body?.answers) ? (req.body.answers as AnswerInput[]) : [];

  // Bounds-check every date BEFORE writing anything, so one bad date can't leave
  // a half-written batch. A past day is editable inside the window; the future
  // never is (its answers would silently pre-fill days that haven't happened).
  for (const a of answers) {
    if (typeof a.entry_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.entry_date)) continue;
    if (a.entry_date > today) return res.status(400).json({ error: "entry_date in the future" });
    if (a.entry_date < oldest) return res.status(400).json({ error: "entry_date outside the edit window" });
  }

  for (const a of answers) {
    if (typeof a.item_id !== "string" || typeof a.option_id !== "string") continue;
    if (typeof a.entry_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.entry_date)) continue;
    // Resolve the chosen option (must belong to the caller + item) to snapshot
    // its label + score at answer time.
    const { data: opt, error: optErr } = await db
      .from("daily_report_options")
      .select("label, score")
      .eq("user_id", userId)
      .eq("item_id", a.item_id)
      .eq("id", a.option_id)
      .maybeSingle();
    // A DB failure here must not be mistaken for "option not found" — silently
    // dropping the answer would still return ok:true and the client would toast
    // success for an answer that was never stored.
    if (optErr) return res.status(500).json({ error: optErr.message });
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

  const { items, error: loadErr } = await loadActive(userId, tz);
  if (loadErr) return res.status(500).json({ error: loadErr });
  if (items.length === 0) return res.json({ today, days: [] });

  const floor = addDays(today, -(MISSED_LOOKBACK_DAYS - 1));

  // All answers in the covered range (floor−1 .. today), one query.
  //
  // The existence of the ROW is what makes a question answered — never
  // `option_id != null`. Saving the question editor deletes and recreates the
  // option rows, and the FK nulls option_id on every historical entry
  // (ON DELETE SET NULL, by design: label + score are snapshotted on the entry).
  // Testing option_id made every day before the last settings save look
  // untouched, which collapsed earliestEngaged to today and hid every missed day.
  const { data: entries, error: entriesErr } = await db
    .from("daily_report_entries")
    .select("entry_date, item_id")
    .eq("user_id", userId)
    .gte("entry_date", addDays(floor, -1))
    .lte("entry_date", today);
  if (entriesErr) return res.status(500).json({ error: entriesErr.message });
  const answeredSet = new Set<string>();
  for (const e of (entries as { entry_date: string; item_id: string }[] | null) ?? []) {
    answeredSet.add(`${e.entry_date}:${e.item_id}`);
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

/**
 * Recent fill-days with their fill status, newest first — the list behind
 * "עריכת ימים קודמים". Unlike /pending this returns FILLED days too — that's the
 * point: reopening a finished day to change an answer. Days on which nothing was
 * ever due (weekday-restricted questions only) are skipped, and days older than
 * the earliest one the user actually engaged with are dropped the same way
 * /pending drops them: due counts come from the CURRENTLY active questions, so
 * every day before the tool was used would otherwise list as "0/N" and invite
 * back-filling days those questions never existed on. Today always stays.
 *
 * `limit` = how many days back to enumerate, capped at the edit window, so every
 * day returned is one PUT /checkin will accept.
 */
router.get("/daily-report/days", async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const tz = await userTz(userId);
  const today = ymdInTz(new Date(), tz);
  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.trunc(rawLimit), EDIT_WINDOW_DAYS)
    : DEFAULT_DAYS_LIMIT;

  const { items, error: loadErr } = await loadActive(userId, tz);
  if (loadErr) return res.status(500).json({ error: loadErr });
  if (items.length === 0) return res.json({ today, days: [] });

  const floor = addDays(today, -(limit - 1));

  // One query for every answer the enumerated fill-days could touch (an 'end'
  // answer of the oldest fill-day lands on floor−1). Row existence = answered,
  // for the same reason spelled out in /pending — option_id is not durable.
  const { data: entries, error: entriesErr } = await db
    .from("daily_report_entries")
    .select("entry_date, item_id")
    .eq("user_id", userId)
    .gte("entry_date", addDays(floor, -1))
    .lte("entry_date", today);
  if (entriesErr) return res.status(500).json({ error: entriesErr.message });
  const answeredSet = new Set<string>();
  for (const e of (entries as { entry_date: string; item_id: string }[] | null) ?? []) {
    answeredSet.add(`${e.entry_date}:${e.item_id}`);
  }

  type Row = { fill_date: string; total_due: number; answered: number; complete: boolean; is_today: boolean };
  const rows: Row[] = [];
  let earliestEngaged: string | null = null; // oldest enumerated fill-day with any answer
  for (let F = today; F >= floor; F = addDays(F, -1)) {
    const sec = dueSections(items, F);
    const due = [
      ...sec.end.items.map((it) => ({ entry_date: sec.end.entry_date, id: it.id })),
      ...sec.start.items.map((it) => ({ entry_date: sec.start.entry_date, id: it.id })),
    ];
    if (due.length === 0) continue;
    const answered = due.filter((d) => answeredSet.has(`${d.entry_date}:${d.id}`)).length;
    if (answered > 0) earliestEngaged = F; // keeps moving back as we go older
    rows.push({
      fill_date: F,
      total_due: due.length,
      answered,
      complete: answered >= due.length,
      is_today: F === today,
    });
  }

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
