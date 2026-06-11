/**
 * Business-day math for the UI — the SAME calendar definition as the smrtPlan
 * engine (server/src/modules/smrtplan/engine.ts): a working day is Mon–Fri
 * and not in the blocked set (global Israeli holidays + per-org rows from
 * smrtplan_blocked_days, fetched via GET /api/work-calendar).
 *
 * Every day-count the user sees (the 3-day desk rule, due-chip urgency colors,
 * aging labels) goes through here so "3 days" always means 3 WORKING days.
 */

/** Blocked-date set, keyed "YYYY-MM-DD". */
export type BlockedDays = Set<string>;

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD as LOCAL midnight (avoids the UTC-midnight day-shift bug). */
export function parseISODateLocal(s: string): Date {
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

/** Mon–Fri and not a holiday — mirrors the engine's isWorkingDay. */
export function isWorkingDay(d: Date, blocked: BlockedDays): boolean {
  const dow = d.getDay();
  if (dow === 6 || dow === 0) return false; // Shabbat + Sunday
  return !blocked.has(toISODate(d));
}

/**
 * Working days from `from` (exclusive) to `to` (inclusive). 0 when `to` is
 * today-or-earlier in working-day terms; negative when `to` is in the past
 * (counts overdue working days, negated).
 */
export function workdaysUntil(fromISO: string, toISO: string, blocked: BlockedDays): number {
  if (fromISO === toISO) return 0;
  const sign = toISO > fromISO ? 1 : -1;
  const start = parseISODateLocal(sign === 1 ? fromISO : toISO);
  const end = parseISODateLocal(sign === 1 ? toISO : fromISO);
  let count = 0;
  const cur = new Date(start);
  // Walk day by day; cap to keep a corrupt range from looping forever.
  for (let i = 0; i < 1000; i++) {
    cur.setDate(cur.getDate() + 1);
    if (cur.getTime() > end.getTime()) break;
    if (isWorkingDay(cur, blocked)) count++;
  }
  return sign * count;
}

export function todayISO(): string {
  return toISODate(new Date());
}

/** Add n WORKING days to a local Date (result lands on a working day). */
export function addWorkdays(from: Date, n: number, blocked: BlockedDays): Date {
  const cur = new Date(from);
  let left = n;
  for (let i = 0; i < 400 && left > 0; i++) {
    cur.setDate(cur.getDate() + 1);
    if (isWorkingDay(cur, blocked)) left--;
  }
  return cur;
}

/** Subtract n WORKING days from a local Date (result lands on a working day). */
export function subWorkdays(from: Date, n: number, blocked: BlockedDays): Date {
  const cur = new Date(from);
  let left = n;
  for (let i = 0; i < 400 && left > 0; i++) {
    cur.setDate(cur.getDate() - 1);
    if (isWorkingDay(cur, blocked)) left--;
  }
  return cur;
}

/**
 * Working days of lead time before a due date at which a freshly-dated task
 * should resurface — the "auto-snooze" the user asked for: set a due date and
 * the item hides itself until two working days before, then pops back so it's
 * never forgotten and never sits on the desk earlier than it needs to.
 */
export const AUTO_SNOOZE_LEAD_WORKDAYS = 2;

/**
 * The auto-snooze moment for a just-set due date: 09:00 local time,
 * AUTO_SNOOZE_LEAD_WORKDAYS working days before `dueISO`.
 *
 * Returns null when that moment is today-or-earlier (i.e. there isn't enough
 * lead time left to be worth hiding the task) — in that case the caller leaves
 * the item visible and applies no auto-snooze.
 */
export function autoSnoozeMoment(
  dueISO: string,
  blocked: BlockedDays,
  today = todayISO(),
): { iso: string; dateISO: string } | null {
  const target = subWorkdays(parseISODateLocal(dueISO), AUTO_SNOOZE_LEAD_WORKDAYS, blocked);
  const dateISO = toISODate(target);
  if (dateISO <= today) return null;
  // 09:00 LOCAL — build from numeric parts so the wall-clock hour is honored
  // regardless of the browser timezone (the same care SnoozeDialog takes).
  const at9 = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 0, 0, 0);
  return { iso: at9.toISOString(), dateISO };
}

export type DueUrgency = "overdue" | "today" | "soon" | "far";

/** Working days within which a deadline counts as "soon" (the desk rule). */
export const DESK_HORIZON_WORKDAYS = 3;

/** Urgency class for a due date, in working days from today. */
export function dueUrgency(dueISO: string, blocked: BlockedDays, today = todayISO()): DueUrgency {
  if (dueISO < today) return "overdue";
  if (dueISO === today) return "today";
  const wd = workdaysUntil(today, dueISO, blocked);
  return wd <= DESK_HORIZON_WORKDAYS ? "soon" : "far";
}

/**
 * The date a task must actually meet — the earlier of its own due date and
 * the engine's latest_finish (an external plan constraint can pull it in).
 * Single source of truth: identical to the smrtPlan TaskZones logic.
 */
export function effectiveDeadline(t: { due_date?: string | null; latest_finish?: string | null }): string | null {
  const due = t.due_date ?? null;
  const lf = t.latest_finish ?? null;
  if (due && lf) return due < lf ? due : lf;
  return due || lf || null;
}

/** Aging thresholds (working days without interaction). */
export const AGING_LABEL_WORKDAYS = 10;
export const AGING_REVIEW_WORKDAYS = 20;

/**
 * Working days a task has been sitting untouched. Falls back to created_at
 * when last_interaction_at was never stamped.
 */
export function sittingWorkdays(
  t: { last_interaction_at?: string | null; created_at: string },
  blocked: BlockedDays,
  today = todayISO(),
): number {
  const ref = (t.last_interaction_at ?? t.created_at).slice(0, 10);
  if (ref >= today) return 0;
  return workdaysUntil(ref, today, blocked);
}
