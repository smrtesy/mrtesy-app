/**
 * דוח יומי — report computation + delivery (shared by the manual "generate now"
 * route and the weekly cron job). See docs/daily-report-plan.md.
 *
 * The report aggregates the user's daily self-report ENTRIES over a date range
 * (in the user's timezone) into per-question answer tallies + averages, an
 * overall average score, and an automatic tasks section (completed tasks by
 * size + worked time). It is delivered as a single smrtTask inbox item, and a
 * daily_report_runs row snapshots the result.
 */

import { db } from "../../../db";
import { emitEvent } from "../../../lib/platform";

const DEFAULT_TZ = "America/New_York";

export type PeriodType = "weekly" | "monthly";

export interface ReportOptionTally {
  label: string;
  count: number;
  /** The option's current score (from the definition), if any. */
  score: number | null;
}
export interface ReportItem {
  item_id: string;
  label: string;
  /** Average of answered scores for this question in range (null if unscored). */
  avg_score: number | null;
  /** How many days this question was answered in range. */
  answered: number;
  options: ReportOptionTally[];
}
export interface ReportTasks {
  quick: number;
  medium: number;
  big: number;
  worked_seconds: number;
}
export interface Report {
  period_type: PeriodType;
  range_start: string; // YYYY-MM-DD inclusive
  range_end: string;   // YYYY-MM-DD inclusive
  overall_score: number | null;
  items: ReportItem[];
  tasks: ReportTasks;
}

// ── timezone-safe date helpers (no external tz lib) ────────────────────────

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function ymdInTz(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Shift a YYYY-MM-DD string by n days (anchored at 12:00 UTC to dodge DST). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Weekday short name ('Tue') + 0-23 hour + day-of-month of an instant in a tz. */
export function localWeekdayHour(d: Date, tz: string): { weekday: string; hour: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "2-digit",
    hour12: false,
    day: "2-digit",
  }).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const day = Number(parts.find((p) => p.type === "day")?.value ?? "1");
  return { weekday, hour, day };
}

/** The trailing window for a period, ending yesterday (in the user's tz). */
export function periodRange(period: PeriodType, todayYmd: string): { start: string; end: string } {
  const end = addDays(todayYmd, -1); // through yesterday
  const span = period === "monthly" ? 30 : 7;
  const start = addDays(end, -(span - 1));
  return { start, end };
}

// ── computation ────────────────────────────────────────────────────────────

interface ItemRow { id: string; label: string; active: boolean; position: number }
interface OptionRow { item_id: string; label: string; score: number | null; position: number }
interface EntryRow { entry_date: string; item_id: string; option_label: string; score_snapshot: number | null }

/**
 * Build the report for [rangeStart, rangeEnd] (inclusive, user-tz dates).
 * Reads only the caller's own rows (service-role client + explicit user filter).
 */
export async function computeReport(
  userId: string,
  tz: string,
  period: PeriodType,
  rangeStart: string,
  rangeEnd: string,
): Promise<Report> {
  // Questions + their current options (for stable ordering + showing 0-count
  // options that were never picked this period).
  const { data: itemRows, error: itemsErr } = await db
    .from("daily_report_items")
    .select("id, label, active, position")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (itemsErr) throw new Error(`items: ${itemsErr.message}`);
  const items = (itemRows as ItemRow[] | null) ?? [];

  const { data: optionRows, error: optsErr } = await db
    .from("daily_report_options")
    .select("item_id, label, score, position")
    .eq("user_id", userId)
    .order("position", { ascending: true });
  if (optsErr) throw new Error(`options: ${optsErr.message}`);
  const options = (optionRows as OptionRow[] | null) ?? [];

  const { data: entryRows, error: entriesErr } = await db
    .from("daily_report_entries")
    .select("entry_date, item_id, option_label, score_snapshot")
    .eq("user_id", userId)
    .gte("entry_date", rangeStart)
    .lte("entry_date", rangeEnd);
  if (entriesErr) throw new Error(`entries: ${entriesErr.message}`);
  const entries = (entryRows as EntryRow[] | null) ?? [];

  const optionsByItem = new Map<string, OptionRow[]>();
  for (const o of options) {
    const arr = optionsByItem.get(o.item_id) ?? [];
    arr.push(o);
    optionsByItem.set(o.item_id, arr);
  }
  const entriesByItem = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const arr = entriesByItem.get(e.item_id) ?? [];
    arr.push(e);
    entriesByItem.set(e.item_id, arr);
  }

  // Only surface questions that are active OR have answers in range (so an
  // archived question the user answered this week still appears, but a
  // never-used archived one doesn't clutter the report).
  const reportItems: ReportItem[] = [];
  for (const item of items) {
    const itemEntries = entriesByItem.get(item.id) ?? [];
    if (!item.active && itemEntries.length === 0) continue;

    // Tally per answer label. Seed from the current option set (so 0-count
    // options show), then fold in any snapshot labels no longer defined.
    const defs = optionsByItem.get(item.id) ?? [];
    const tally = new Map<string, ReportOptionTally>();
    for (const d of defs) tally.set(d.label, { label: d.label, count: 0, score: num(d.score) });
    for (const e of itemEntries) {
      const existing = tally.get(e.option_label);
      if (existing) existing.count += 1;
      else tally.set(e.option_label, { label: e.option_label, count: 1, score: num(e.score_snapshot) });
    }

    const scored = itemEntries.map((e) => num(e.score_snapshot)).filter((n): n is number => n != null);
    const avg = scored.length
      ? scored.reduce((s, n) => s + n, 0) / scored.length
      : null;

    reportItems.push({
      item_id: item.id,
      label: item.label,
      avg_score: avg == null ? null : round1(avg),
      answered: itemEntries.length,
      options: Array.from(tally.values()),
    });
  }

  // Overall score = mean of every scored answer across all questions in range.
  const allScored = entries.map((e) => num(e.score_snapshot)).filter((n): n is number => n != null);
  const overall = allScored.length
    ? round1(allScored.reduce((s, n) => s + n, 0) / allScored.length)
    : null;

  const tasks = await computeTasksSection(userId, tz, rangeStart, rangeEnd);

  return {
    period_type: period,
    range_start: rangeStart,
    range_end: rangeEnd,
    overall_score: overall,
    items: reportItems,
    tasks,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Coerce a possibly-string numeric column (PostgREST may serialize `numeric`
 *  as a string) to a finite number, or null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Automatic section: completed tasks by size + worked seconds, in range. */
async function computeTasksSection(
  userId: string,
  tz: string,
  rangeStart: string,
  rangeEnd: string,
): Promise<ReportTasks> {
  const out: ReportTasks = { quick: 0, medium: 0, big: 0, worked_seconds: 0 };

  // Completed tasks: fetch a generous UTC window around the range, then bucket
  // by the user-tz completion date so tz never has to be converted to UTC here.
  const fromUtc = `${addDays(rangeStart, -1)}T00:00:00Z`;
  const toUtc = `${addDays(rangeEnd, 2)}T00:00:00Z`;
  const { data: taskRows, error: taskErr } = await db
    .from("tasks")
    .select("size, completed_at")
    .eq("user_id", userId)
    .not("completed_at", "is", null)
    .gte("completed_at", fromUtc)
    .lt("completed_at", toUtc);
  if (taskErr) throw new Error(`tasks section: ${taskErr.message}`);
  for (const r of (taskRows as { size: string | null; completed_at: string }[] | null) ?? []) {
    const day = ymdInTz(new Date(r.completed_at), tz);
    if (day < rangeStart || day > rangeEnd) continue;
    if (r.size === "quick") out.quick += 1;
    else if (r.size === "medium") out.medium += 1;
    else if (r.size === "big") out.big += 1;
  }

  // Worked time: work_sessions.work_date is already a user-tz date.
  const { data: sessionRows, error: sessErr } = await db
    .from("work_sessions")
    .select("worked_seconds")
    .eq("user_id", userId)
    .gte("work_date", rangeStart)
    .lte("work_date", rangeEnd);
  if (sessErr) throw new Error(`work sessions: ${sessErr.message}`);
  for (const s of (sessionRows as { worked_seconds: number | null }[] | null) ?? []) {
    out.worked_seconds += s.worked_seconds ?? 0;
  }

  return out;
}

// ── delivery (Hebrew inbox item + run snapshot) ─────────────────────────────

function fmtDateHe(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}
function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h && m) return `${h} שע׳ ${m} דק׳`;
  if (h) return `${h} שע׳`;
  return `${m} דק׳`;
}

/** Render the report as a Hebrew inbox item title + description. */
export function renderInbox(report: Report): { title: string; description: string } {
  const periodLabel = report.period_type === "monthly" ? "חודשי" : "שבועי";
  const title = `📊 דוח ${periodLabel} · ${fmtDateHe(report.range_start)}–${fmtDateHe(report.range_end)}`;

  const lines: string[] = [];
  if (report.overall_score != null) {
    lines.push(`ניקוד כללי: ${report.overall_score}`);
    lines.push("");
  }

  for (const item of report.items) {
    lines.push(item.label);
    for (const o of item.options) {
      lines.push(`  ${o.label} – ${o.count}`);
    }
    if (item.avg_score != null) lines.push(`  ממוצע: ${item.avg_score}`);
    lines.push("");
  }

  const tk = report.tasks;
  lines.push("משימות שנסגרו");
  lines.push(`  מהיר – ${tk.quick}`);
  lines.push(`  בינוני – ${tk.medium}`);
  lines.push(`  גדול – ${tk.big}`);
  lines.push(`  זמן עבודה – ${fmtDuration(tk.worked_seconds)}`);

  return { title, description: lines.join("\n").trim() };
}

/**
 * Generate + deliver a report: insert a run snapshot and upsert the inbox item
 * (deduped by range so a re-run refreshes the same task). Returns the report
 * and the run id.
 */
export async function generateAndDeliver(
  userId: string,
  orgId: string,
  tz: string,
  period: PeriodType,
  rangeStart: string,
  rangeEnd: string,
  generatedBy: "schedule" | "manual",
): Promise<{ report: Report; run_id: string; task_id: string | null }> {
  const report = await computeReport(userId, tz, period, rangeStart, rangeEnd);
  const { title, description } = renderInbox(report);
  const dedupTag = `daily-report:${rangeStart}`;

  // Upsert the inbox task by dedup tag (same pattern as claude-session).
  const { data: existingTask } = await db
    .from("tasks")
    .select("id")
    .eq("organization_id", orgId)
    .eq("user_id", userId)
    .contains("tags", [dedupTag])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  let taskId: string | null = null;
  if (existingTask) {
    const { data: upd, error } = await db
      .from("tasks")
      .update({ title, title_he: title, description, updated_at: new Date().toISOString() })
      .eq("organization_id", orgId)
      .eq("id", existingTask.id)
      .select("id")
      .single();
    if (error) throw new Error(`task update: ${error.message}`);
    taskId = upd.id;
  } else {
    const { data: created, error } = await db
      .from("tasks")
      .insert({
        user_id: userId,
        organization_id: orgId,
        task_type: "followup",
        status: "inbox",
        priority: "low",
        manually_verified: false,
        title,
        title_he: title,
        description,
        tags: ["daily-report", dedupTag],
        ai_model_used: null,
      })
      .select("id")
      .single();
    if (error) throw new Error(`task insert: ${error.message}`);
    taskId = created.id;
    await emitEvent(orgId, "smrttask", "task.created", "task", created.id, {
      title,
      priority: "low",
      source: "daily-report",
    });
  }

  const { data: run, error: runErr } = await db
    .from("daily_report_runs")
    .insert({
      user_id: userId,
      org_id: orgId,
      period_type: period,
      range_start: rangeStart,
      range_end: rangeEnd,
      overall_score: report.overall_score,
      breakdown: { items: report.items, tasks: report.tasks },
      generated_by: generatedBy,
      task_id: taskId,
    })
    .select("id")
    .single();
  if (runErr) console.error("[daily-report] run insert failed:", runErr.message);

  return { report, run_id: (run?.id as string) ?? "", task_id: taskId };
}

export { DEFAULT_TZ };
