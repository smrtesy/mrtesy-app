/**
 * Recurrence engine for smrtTask recurring tasks.
 *
 * recurrence_rule is a compact, RRULE-flavoured string we own end-to-end:
 *
 *   FREQ=DAILY
 *   FREQ=WEEKLY                       (same weekday as the base date)
 *   FREQ=WEEKLY;BYDAY=SU,TU,TH        (every Sun/Tue/Thu — "כל ב' ו-ה'")
 *   FREQ=MONTHLY                      (same day-of-month)
 *   FREQ=YEARLY                       (same Gregorian month + day)
 *   FREQ=HEBREW_YEARLY                (same Hebrew date next year — e.g. ט"ו בשבט)
 *
 * `nextOccurrence` returns the next date strictly AFTER `baseDate`, as a
 * `YYYY-MM-DD` string, or null when the rule is empty / unrecognised.
 */

import { HDate } from "@hebcal/core";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const VALID_FREQ = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY", "HEBREW_YEARLY"]);

interface ParsedRule {
  freq: string;
  byday: number[]; // 0=Sun .. 6=Sat
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

  let byday: number[] = [];
  if (parts.BYDAY) {
    byday = parts.BYDAY.split(",")
      .map((d) => WEEKDAY_CODES.indexOf(d.trim() as (typeof WEEKDAY_CODES)[number]))
      .filter((i) => i >= 0);
  }
  if (freq === "WEEKLY" && parts.BYDAY && byday.length === 0) return null; // BYDAY given but garbage
  return { freq, byday };
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

  switch (parsed.freq) {
    case "DAILY": {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + 1);
      return toDateOnly(d);
    }
    case "WEEKLY": {
      if (parsed.byday.length > 0) {
        // Next date (within 7 days) whose weekday is in the set.
        for (let i = 1; i <= 7; i++) {
          const d = new Date(base);
          d.setUTCDate(d.getUTCDate() + i);
          if (parsed.byday.includes(d.getUTCDay())) return toDateOnly(d);
        }
        return null; // unreachable for a non-empty set
      }
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + 7);
      return toDateOnly(d);
    }
    case "MONTHLY": {
      const d = new Date(base);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return toDateOnly(d);
    }
    case "YEARLY": {
      const d = new Date(base);
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      return toDateOnly(d);
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
        // Same Hebrew month + day, one Hebrew year later.
        const g = new HDate(hd.getDate(), hd.getMonth(), hd.getFullYear() + 1).greg();
        const y = g.getFullYear();
        const m = String(g.getMonth() + 1).padStart(2, "0");
        const d = String(g.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      } catch {
        // Day/month doesn't exist next Hebrew year (leap-year Adar, day 30 of a
        // 29-day month, …). Fall back to a plain Gregorian year hop.
        localBase.setFullYear(localBase.getFullYear() + 1);
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
