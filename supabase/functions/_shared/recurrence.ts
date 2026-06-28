// Mirror of server/src/modules/smrttask/tasks/recurrence.ts — kept in sync so
// the reminders-check cron advances recurring tasks with the SAME cadence math
// the create/complete routes use. If you change one, change the other.
//
// Only the read-only date arithmetic is ported (parseRule / stepOnce /
// nextOccurrence + a recurrenceFreq helper). COUNT→until normalisation lives on
// the create route alone and is intentionally NOT duplicated here.

import { HDate } from "npm:@hebcal/core";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const VALID_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "HEBREW_YEARLY", "HEBREW_MONTHLY"]);
const DAY_MS = 24 * 60 * 60 * 1000;

interface ParsedRule {
  freq: string;
  interval: number;
  byday: number[];
  bydayOrdinal: { ordinal: number; weekday: number } | null;
  bymonthday: number | null;
  count: number | null;
}

function parseRule(rule: string): ParsedRule | null {
  if (!rule || typeof rule !== "string") return null;
  const parts: Record<string, string> = {};
  for (const seg of rule.split(";")) {
    const [k, v] = seg.split("=");
    if (k && v) parts[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  const freq = parts.FREQ;
  if (!freq || !VALID_FREQ.has(freq)) return null;

  let interval = 1;
  if (parts.INTERVAL !== undefined) {
    const n = parseInt(parts.INTERVAL, 10);
    if (!Number.isInteger(n) || n < 1) return null;
    interval = n;
  }

  let count: number | null = null;
  if (parts.COUNT !== undefined) {
    const n = parseInt(parts.COUNT, 10);
    if (!Number.isInteger(n) || n < 1) return null;
    count = n;
  }

  let byday: number[] = [];
  let bydayOrdinal: { ordinal: number; weekday: number } | null = null;
  if (parts.BYDAY) {
    const codes = parts.BYDAY.split(",").map((s) => s.trim()).filter(Boolean);
    if (freq === "MONTHLY") {
      if (codes.length !== 1) return null;
      const m = codes[0].match(/^(-?\d+)(SU|MO|TU|WE|TH|FR|SA)$/);
      if (!m) return null;
      const ordinal = parseInt(m[1], 10);
      const weekday = WEEKDAY_CODES.indexOf(m[2] as (typeof WEEKDAY_CODES)[number]);
      if (weekday < 0 || ordinal === 0 || ordinal < -1 || ordinal > 5) return null;
      bydayOrdinal = { ordinal, weekday };
    } else if (freq === "WEEKLY") {
      byday = codes
        .map((d) => WEEKDAY_CODES.indexOf(d as (typeof WEEKDAY_CODES)[number]))
        .filter((i) => i >= 0);
      if (byday.length === 0) return null;
    }
  }

  let bymonthday: number | null = null;
  if (parts.BYMONTHDAY !== undefined && freq === "MONTHLY") {
    const n = parseInt(parts.BYMONTHDAY, 10);
    if (!Number.isInteger(n) || n < 1 || n > 31) return null;
    bymonthday = n;
  }
  return { freq, interval, byday, bydayOrdinal, bymonthday, count };
}

/** The FREQ of a rule (DAILY/WEEKLY/MONTHLY/…), or null if unparseable. Used to
 *  pick roll-forward (high-frequency) vs. stack (low-frequency) advancement. */
export function recurrenceFreq(rule: string): string | null {
  return parseRule(rule)?.freq ?? null;
}

function toDateOnly(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromDateOnly(value: string): Date {
  const datePart = value.slice(0, 10);
  return new Date(`${datePart}T00:00:00.000Z`);
}

function weekStartMs(d: Date): number {
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

function nthWeekdayOfMonth(year: number, month0: number, weekday: number, ordinal: number): Date | null {
  if (ordinal > 0) {
    const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    const day = 1 + ((weekday - firstDow + 7) % 7) + (ordinal - 1) * 7;
    const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    if (day > daysInMonth) return null;
    return new Date(Date.UTC(year, month0, day));
  }
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return new Date(Date.UTC(year, month0, day));
}

/**
 * Next occurrence strictly after `baseDateStr`. If `notBeforeStr` is given, keep
 * stepping until the result lands strictly after it too — so an occurrence that
 * fell behind still advances to a date on/after "now" while preserving cadence.
 */
export function nextOccurrence(rule: string, baseDateStr: string, notBeforeStr?: string): string | null {
  let next = stepOnce(rule, baseDateStr);
  if (!next || !notBeforeStr) return next;
  for (let i = 0; i < 500 && next <= notBeforeStr; i++) {
    const advanced = stepOnce(rule, next);
    if (!advanced || advanced === next) break;
    next = advanced;
  }
  return next;
}

function stepOnce(rule: string, baseDateStr: string): string | null {
  const parsed = parseRule(rule);
  if (!parsed) return null;

  const base = fromDateOnly(baseDateStr);
  if (Number.isNaN(base.getTime())) return null;
  const step = parsed.interval;

  switch (parsed.freq) {
    case "DAILY": {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + step);
      return toDateOnly(d);
    }
    case "WEEKLY": {
      if (parsed.byday.length > 0) {
        const baseWeek = weekStartMs(base);
        const horizon = step * 7 + 7;
        for (let i = 1; i <= horizon; i++) {
          const d = new Date(base);
          d.setUTCDate(d.getUTCDate() + i);
          if (!parsed.byday.includes(d.getUTCDay())) continue;
          const weeksAhead = Math.round((weekStartMs(d) - baseWeek) / (7 * DAY_MS));
          if (weeksAhead === 0 || weeksAhead % step === 0) return toDateOnly(d);
        }
        return null;
      }
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + 7 * step);
      return toDateOnly(d);
    }
    case "MONTHLY": {
      if (parsed.bydayOrdinal) {
        const { ordinal, weekday } = parsed.bydayOrdinal;
        let y = base.getUTCFullYear();
        let m = base.getUTCMonth() + step;
        for (let i = 0; i < 48; i++) {
          y += Math.floor(m / 12);
          m = ((m % 12) + 12) % 12;
          const hit = nthWeekdayOfMonth(y, m, weekday, ordinal);
          if (hit && hit.getTime() > base.getTime()) return toDateOnly(hit);
          m += step;
        }
        return null;
      }
      if (parsed.bymonthday) {
        let y = base.getUTCFullYear();
        let m = base.getUTCMonth() + step;
        for (let i = 0; i < 48; i++) {
          y += Math.floor(m / 12);
          m = ((m % 12) + 12) % 12;
          const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
          if (parsed.bymonthday <= daysInMonth) {
            const d = new Date(Date.UTC(y, m, parsed.bymonthday));
            if (d.getTime() > base.getTime()) return toDateOnly(d);
          }
          m += step;
        }
        return null;
      }
      const d = new Date(base);
      d.setUTCMonth(d.getUTCMonth() + step);
      return toDateOnly(d);
    }
    case "YEARLY": {
      const d = new Date(base);
      d.setUTCFullYear(d.getUTCFullYear() + step);
      return toDateOnly(d);
    }
    case "HEBREW_MONTHLY": {
      const [by, bm, bd] = baseDateStr.slice(0, 10).split("-").map(Number);
      const localBase = new Date(by, (bm ?? 1) - 1, bd ?? 1);
      try {
        const g = new HDate(localBase).add(step, "month").greg();
        const y = g.getFullYear();
        const m = String(g.getMonth() + 1).padStart(2, "0");
        const d = String(g.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      } catch {
        localBase.setMonth(localBase.getMonth() + step);
        const y = localBase.getFullYear();
        const m = String(localBase.getMonth() + 1).padStart(2, "0");
        const d = String(localBase.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
    }
    case "HEBREW_YEARLY": {
      const [by, bm, bd] = baseDateStr.slice(0, 10).split("-").map(Number);
      const localBase = new Date(by, (bm ?? 1) - 1, bd ?? 1);
      try {
        const hd = new HDate(localBase);
        const g = new HDate(hd.getDate(), hd.getMonth(), hd.getFullYear() + step).greg();
        const y = g.getFullYear();
        const m = String(g.getMonth() + 1).padStart(2, "0");
        const d = String(g.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      } catch {
        localBase.setFullYear(localBase.getFullYear() + step);
        const y = localBase.getFullYear();
        const m = String(localBase.getMonth() + 1).padStart(2, "0");
        const d = String(localBase.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      }
    }
    default:
      return null;
  }
}
