/**
 * דוח יומי — Hebrew + Gregorian date labels (client). Mirrors the server helper
 * server/src/modules/smrttask/daily-report/hebdate.ts 1:1 so a label reads
 * identically whether it was rendered into the inbox item by the server or
 * shown live in the check-in / report screen.
 *
 * Inputs are plain calendar dates (YYYY-MM-DD); we anchor at noon UTC and
 * format in UTC so the day never drifts across a DST boundary.
 */

const HEB_WEEKDAYS = [
  "יום ראשון", // 0 Sun
  "יום שני",   // 1 Mon
  "יום שלישי", // 2 Tue
  "יום רביעי", // 3 Wed
  "יום חמישי", // 4 Thu
  "יום שישי",  // 5 Fri
  "שבת",       // 6 Sat
];

/** Weekday short chips (settings editor), Sunday-first. */
export const WEEKDAY_SHORT = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
export const WEEKDAY_NUMS = [0, 1, 2, 3, 4, 5, 6];

let _dayF: Intl.DateTimeFormat | null = null;
let _monthF: Intl.DateTimeFormat | null = null;
let _yearF: Intl.DateTimeFormat | null = null;
let _probed = false;
let _supported = false;

function formatters() {
  if (!_probed) {
    _probed = true;
    try {
      _dayF = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", timeZone: "UTC" });
      _monthF = new Intl.DateTimeFormat("he-u-ca-hebrew", { month: "long", timeZone: "UTC" });
      _yearF = new Intl.DateTimeFormat("he-u-ca-hebrew", { year: "numeric", timeZone: "UTC" });
      _supported = /\d/.test(_dayF.format(new Date()));
    } catch {
      _supported = false;
    }
  }
  return { dayF: _dayF, monthF: _monthF, yearF: _yearF };
}

function noonUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

export function gematriaDay(n: number): string {
  if (n === 15) return "ט״ו";
  if (n === 16) return "ט״ז";
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל"];
  const s = tens[Math.floor(n / 10)] + ones[n % 10];
  return s.length > 1 ? s.slice(0, -1) + "״" + s.slice(-1) : s + "׳";
}

function hebMonthName(d: Date): string {
  const { monthF } = formatters();
  if (!monthF) return "";
  const raw = monthF.format(d).replace(/^ב/, "").trim();
  return raw === "אב" ? "מנחם אב" : raw;
}

export function weekdayHe(ymd: string): string {
  return HEB_WEEKDAYS[noonUtc(ymd).getUTCDay()] ?? "";
}

export function weekdayNum(ymd: string): number {
  return noonUtc(ymd).getUTCDay();
}

export function hebDate(ymd: string): string {
  const { dayF } = formatters();
  if (!_supported || !dayF) return "";
  const d = noonUtc(ymd);
  const day = gematriaDay(parseInt(dayF.format(d), 10) || 0);
  const month = hebMonthName(d);
  if (!day || !month) return "";
  return `${day} ${month}`;
}

export function gregHe(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

/** "יום שני · ח׳ מנחם אב · 21/07/2026" */
export function dayLabel(ymd: string): string {
  return [weekdayHe(ymd), hebDate(ymd), gregHe(ymd)].filter(Boolean).join(" · ");
}

/** Range label, collapsing a shared Hebrew month: "ח׳–י״ד מנחם אב · 21/07–27/07/2026". */
export function rangeLabel(startYmd: string, endYmd: string): string {
  const greg = `${gregHe(startYmd)}–${gregHe(endYmd)}`;
  const { dayF } = formatters();
  if (!_supported || !dayF) return greg;
  const sD = noonUtc(startYmd);
  const eD = noonUtc(endYmd);
  const sMonth = hebMonthName(sD);
  const eMonth = hebMonthName(eD);
  const sDay = gematriaDay(parseInt(dayF.format(sD), 10) || 0);
  const eDay = gematriaDay(parseInt(dayF.format(eD), 10) || 0);
  const heb =
    sMonth === eMonth && _yearMatch(startYmd, endYmd)
      ? `${sDay}–${eDay} ${sMonth}`
      : `${sDay} ${sMonth} – ${eDay} ${eMonth}`;
  return heb ? `${heb} · ${greg}` : greg;
}

function _yearMatch(a: string, b: string): boolean {
  const { yearF } = formatters();
  if (!yearF) return false;
  return yearF.format(noonUtc(a)) === yearF.format(noonUtc(b));
}

/** Shift a YYYY-MM-DD by n days (noon-UTC anchored). */
export function addDays(ymd: string, n: number): string {
  const d = noonUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
