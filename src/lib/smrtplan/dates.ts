/**
 * smrtPlan date helpers — Gregorian + Hebrew formatting and countdowns.
 *
 * Ported from the board / task prototypes. The Hebrew formatting uses the
 * built-in Intl Hebrew calendar (no external dependency); gematria day numerals
 * are rendered manually because Intl emits Latin digits for the day.
 */

const DAY_MS = 86_400_000;

export function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isoOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function gregShort(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Hebrew day numeral in gematria (e.g. 15 → ט״ו). */
export function gematriaDay(n: number): string {
  if (n === 15) return "ט״ו";
  if (n === 16) return "ט״ז";
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל"];
  const s = tens[Math.floor(n / 10)] + ones[n % 10];
  return s.length > 1 ? s.slice(0, -1) + "״" + s.slice(-1) : s + "׳";
}

let _dF: Intl.DateTimeFormat | null = null;
let _mF: Intl.DateTimeFormat | null = null;
function hebFormatters() {
  if (!_dF) {
    try {
      _dF = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric" });
      _mF = new Intl.DateTimeFormat("he-u-ca-hebrew", { month: "long" });
    } catch {
      _dF = null;
      _mF = null;
    }
  }
  return { dF: _dF, mF: _mF };
}

/** Hebrew day numeral only, e.g. "ז׳". Empty string if Intl lacks the calendar. */
export function hebDay(d: Date): string {
  const { dF } = hebFormatters();
  if (!dF) return "";
  return gematriaDay(parseInt(dF.format(d), 10));
}

/** Hebrew month name only, e.g. "אלול". Empty string if Intl lacks the calendar. */
export function hebMonth(d: Date): string {
  const { mF } = hebFormatters();
  if (!mF) return "";
  return mF.format(d).replace(/^ב/, "");
}

/** Hebrew date label, e.g. "ז׳ אלול". Empty string if Intl lacks the calendar. */
export function hebDate(d: Date): string {
  const day = hebDay(d);
  const month = hebMonth(d);
  if (!day || !month) return "";
  return `${day} ${month}`;
}

/** Localised Gregorian month + year, e.g. "יוני 2026" / "June 2026". */
export function gregMonthLabel(d: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en" : "he", {
    month: "long",
    year: "numeric",
  }).format(d);
}

export function daysBetween(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / DAY_MS);
}

/** Count working days (Mon–Fri, minus the holiday set) in [from, to] inclusive.
 *  Used for the roster "load" gauge: available work days vs task-days assigned. */
export function countWorkingDays(from: Date, to: Date, holidays?: Set<string>): number {
  let n = 0;
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6 && !holidays?.has(isoOf(cur))) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

export type Urgency = "far" | "soon" | "urgent";

/** Urgency bucket for a due date relative to `today` (default: now). */
export function urgencyFor(dueISO: string | null | undefined, today = new Date()): Urgency | null {
  if (!dueISO) return null;
  const n = daysBetween(today, parseISO(dueISO));
  if (n <= 3) return "urgent";
  if (n <= 7) return "soon";
  return "far";
}

/** Localised countdown text via the smrtPlan.countdown messages. */
export function countdownText(
  dueISO: string,
  t: (key: string, vals?: Record<string, string | number | Date>) => string,
  today = new Date(),
): string {
  const n = daysBetween(today, parseISO(dueISO));
  if (n === 0) return t("countdown.today");
  if (n === 1) return t("countdown.oneDayLeft");
  if (n > 1) return t("countdown.daysLeft", { n });
  if (n === -1) return t("countdown.onePassed");
  return t("countdown.daysPassed", { n: -n });
}
