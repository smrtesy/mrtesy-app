/**
 * Recurrence engine for smrtTask recurring tasks.
 *
 * recurrence_rule is a compact, RRULE-flavoured string we own end-to-end:
 *
 *   FREQ=DAILY                        (every day)
 *   FREQ=DAILY;INTERVAL=3             (every 3 days)
 *   FREQ=WEEKLY                       (same weekday as the base date)
 *   FREQ=WEEKLY;BYDAY=SU,TU,TH        (every Sun/Tue/Thu — "כל ב' ו-ה'")
 *   FREQ=WEEKLY;INTERVAL=2;BYDAY=MO   (every 2nd Monday-week)
 *   FREQ=MONTHLY                      (same day-of-month)
 *   FREQ=MONTHLY;INTERVAL=2           (same day-of-month, every 2 months)
 *   FREQ=MONTHLY;BYDAY=2MO            (the 2nd Monday of the month)
 *   FREQ=MONTHLY;BYDAY=-1SU           (the LAST Sunday of the month)
 *   FREQ=YEARLY                       (same Gregorian month + day)
 *   FREQ=HEBREW_YEARLY                (same Hebrew date next year — e.g. ט"ו בשבט)
 *
 * Two extra segments are accepted on input but never live in a stored rule:
 *   INTERVAL=n  — cadence multiplier (default 1).
 *   COUNT=n     — "ends after n occurrences" (the first one counts). The
 *                 create route resolves COUNT into a concrete recurrence_until
 *                 date via `normalizeRecurrence`, then strips it, so the engine
 *                 below never has to track how many instances have spawned.
 *
 * `nextOccurrence` returns the next date strictly AFTER `baseDate`, as a
 * `YYYY-MM-DD` string, or null when the rule is empty / unrecognised.
 */

import { HDate } from "@hebcal/core";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const VALID_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "HEBREW_YEARLY", "HEBREW_MONTHLY"]);
const DAY_MS = 24 * 60 * 60 * 1000;

interface ParsedRule {
  freq: string;
  interval: number;            // >= 1
  byday: number[];             // 0=Sun .. 6=Sat — WEEKLY only
  bydayOrdinal: { ordinal: number; weekday: number } | null; // MONTHLY nth weekday
  bymonthday: number | null;   // MONTHLY day-of-month (1..31)
  count: number | null;        // occurrences incl. the first; null = open-ended
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
      // A single ordinal weekday: "2MO" (2nd Mon), "-1SU" (last Sun).
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
      if (byday.length === 0) return null; // BYDAY given but garbage
    }
    // BYDAY on DAILY/YEARLY/HEBREW_* is meaningless — ignore it.
  }

  let bymonthday: number | null = null;
  if (parts.BYMONTHDAY !== undefined && freq === "MONTHLY") {
    const n = parseInt(parts.BYMONTHDAY, 10);
    if (!Number.isInteger(n) || n < 1 || n > 31) return null;
    bymonthday = n;
  }
  return { freq, interval, byday, bydayOrdinal, bymonthday, count };
}

/** Light validator for the create/update routes. */
export function isValidRecurrenceRule(rule: unknown): boolean {
  return typeof rule === "string" && parseRule(rule) !== null;
}

function toDateOnly(d: Date): string {
  // Use UTC components so a date-only value never drifts across a tz boundary.
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a `YYYY-MM-DD` (or ISO) string into a UTC-anchored Date. */
function fromDateOnly(value: string): Date {
  const datePart = value.slice(0, 10);
  return new Date(`${datePart}T00:00:00.000Z`);
}

/** UTC midnight of the Sunday that opens the week containing `d`. */
function weekStartMs(d: Date): number {
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  start.setUTCHours(0, 0, 0, 0);
  return start.getTime();
}

/** The `ordinal`-th `weekday` of (year, month0), or null when it doesn't exist
 *  (only possible for a 5th occurrence). ordinal -1 = the LAST one. */
function nthWeekdayOfMonth(year: number, month0: number, weekday: number, ordinal: number): Date | null {
  if (ordinal > 0) {
    const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
    const day = 1 + ((weekday - firstDow + 7) % 7) + (ordinal - 1) * 7;
    const daysInMonth = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
    if (day > daysInMonth) return null;
    return new Date(Date.UTC(year, month0, day));
  }
  // ordinal === -1 → last occurrence of the weekday in the month.
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  const day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  return new Date(Date.UTC(year, month0, day));
}

/**
 * Next occurrence strictly after `baseDateStr`. If `notBeforeStr` is given, the
 * cadence keeps stepping until it lands strictly after that date too — so a task
 * completed late still advances to a FUTURE instance instead of a stale one,
 * while preserving the rule's cadence (day-of-month, weekday, …).
 */
export function nextOccurrence(rule: string, baseDateStr: string, notBeforeStr?: string): string | null {
  let next = stepOnce(rule, baseDateStr);
  if (!next || !notBeforeStr) return next;
  // Cap the catch-up loop so a misconfigured rule can never spin forever.
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
        // Walk forward day by day. A candidate qualifies when its weekday is in
        // the set AND it falls either in the base's own week (a later day) or in
        // a week an exact multiple of `interval` ahead. Anchoring on `base`
        // (itself an on-cadence occurrence) keeps the modulo correct without
        // needing the original series start.
        const baseWeek = weekStartMs(base);
        const horizon = step * 7 + 7;
        for (let i = 1; i <= horizon; i++) {
          const d = new Date(base);
          d.setUTCDate(d.getUTCDate() + i);
          if (!parsed.byday.includes(d.getUTCDay())) continue;
          const weeksAhead = Math.round((weekStartMs(d) - baseWeek) / (7 * DAY_MS));
          if (weeksAhead === 0 || weeksAhead % step === 0) return toDateOnly(d);
        }
        return null; // unreachable for a non-empty set
      }
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + 7 * step);
      return toDateOnly(d);
    }
    case "MONTHLY": {
      if (parsed.bydayOrdinal) {
        const { ordinal, weekday } = parsed.bydayOrdinal;
        // Advance whole months by `interval`; a 5th-occurrence rule may skip a
        // month that has only four — keep stepping until one materialises.
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
        // A fixed day-of-month. Skip months that are too short for the day
        // (e.g. day 31 in a 30-day month) — Google Calendar does the same.
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
      // Same Hebrew day-of-month, `interval` Hebrew months later. HDate.add
      // handles month-length and year-boundary (incl. leap Adar) arithmetic.
      // Anchor on local midnight so the greg() result never drifts a day.
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
      // HDate works in the *local* calendar: HDate(jsDate) reads local Y/M/D and
      // .greg() returns a local-midnight Date. Anchor on a local-midnight base
      // and read local components back, so the result never drifts a day under a
      // non-UTC server timezone.
      const [by, bm, bd] = baseDateStr.slice(0, 10).split("-").map(Number);
      const localBase = new Date(by, (bm ?? 1) - 1, bd ?? 1);
      try {
        const hd = new HDate(localBase);
        // Same Hebrew month + day, `interval` Hebrew years later.
        const g = new HDate(hd.getDate(), hd.getMonth(), hd.getFullYear() + step).greg();
        const y = g.getFullYear();
        const m = String(g.getMonth() + 1).padStart(2, "0");
        const d = String(g.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      } catch {
        // Day/month doesn't exist next Hebrew year (leap-year Adar, day 30 of a
        // 29-day month, …). Fall back to a plain Gregorian year hop.
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

/** Re-serialize a parsed rule into its canonical stored form (no COUNT). */
function buildCanonical(p: ParsedRule): string {
  const parts = [`FREQ=${p.freq}`];
  if (p.interval > 1) parts.push(`INTERVAL=${p.interval}`);
  if (p.freq === "WEEKLY" && p.byday.length) {
    parts.push(`BYDAY=${p.byday.slice().sort((a, b) => a - b).map((d) => WEEKDAY_CODES[d]).join(",")}`);
  }
  if (p.freq === "MONTHLY" && p.bydayOrdinal) {
    parts.push(`BYDAY=${p.bydayOrdinal.ordinal}${WEEKDAY_CODES[p.bydayOrdinal.weekday]}`);
  }
  if (p.freq === "MONTHLY" && !p.bydayOrdinal && p.bymonthday) {
    parts.push(`BYMONTHDAY=${p.bymonthday}`);
  }
  return parts.join(";");
}

/**
 * Resolve an incoming recurrence_rule into the canonical rule we store plus an
 * optional recurrence_until. The only transformation is COUNT → until:
 *   { rule: "FREQ=WEEKLY;COUNT=4", until: null }  with start 2026-06-15
 *     → { rule: "FREQ=WEEKLY", until: "2026-07-06" }   (the 4th Sunday)
 * The cadence (INTERVAL / BYDAY) is preserved; COUNT is stripped so the lazy
 * spawn engine never has to count instances. Returns null for an invalid rule.
 */
export function normalizeRecurrence(
  rule: string,
  startDateStr?: string,
): { rule: string; until: string | null } | null {
  const p = parseRule(rule);
  if (!p) return null;
  const canonical = buildCanonical(p);
  if (p.count && p.count > 1 && startDateStr) {
    let cur = startDateStr.slice(0, 10);
    for (let i = 1; i < p.count; i++) {
      const n = stepOnce(canonical, cur);
      if (!n) break;
      cur = n;
    }
    return { rule: canonical, until: cur };
  }
  // COUNT=1 → a single occurrence: it ends on its own start date.
  if (p.count === 1 && startDateStr) {
    return { rule: canonical, until: startDateStr.slice(0, 10) };
  }
  return { rule: canonical, until: null };
}
