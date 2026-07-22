/**
 * דוח יומי — Hebrew + Gregorian date labels for report titles and section
 * headers. Built on the runtime's Intl Hebrew calendar (full ICU ships with
 * Node 18+), mirroring the client helpers in src/lib/smrtplan/dates.ts so a
 * label reads identically on both sides.
 *
 * All inputs are plain calendar dates (YYYY-MM-DD) with no timezone — the day
 * itself already carries the user's tz meaning (it was derived with ymdInTz).
 * We anchor at noon UTC and format in UTC so the calendar day never drifts.
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

/** noon-UTC Date for a YYYY-MM-DD (so calendar math never drifts on DST). */
function noonUtc(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

/** Hebrew day-of-month numeral in gematria, e.g. 8 → "ח׳", 15 → "ט״ו". */
export function gematriaDay(n: number): string {
  if (n === 15) return "ט״ו";
  if (n === 16) return "ט״ז";
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל"];
  const s = tens[Math.floor(n / 10)] + ones[n % 10];
  return s.length > 1 ? s.slice(0, -1) + "״" + s.slice(-1) : s + "׳";
}

/** Month name, applying the customary "מנחם אב" for Av. */
function hebMonthName(d: Date): string {
  const { monthF } = formatters();
  if (!monthF) return "";
  const raw = monthF.format(d).replace(/^ב/, "").trim();
  return raw === "אב" ? "מנחם אב" : raw;
}

/** Hebrew weekday name of a calendar date, e.g. "יום שני". */
export function weekdayHe(ymd: string): string {
  return HEB_WEEKDAYS[noonUtc(ymd).getUTCDay()] ?? "";
}

/** Weekday number of a calendar date (0=Sun..6=Sat), tz-independent. */
export function weekdayNum(ymd: string): number {
  return noonUtc(ymd).getUTCDay();
}

/** Hebrew date only, e.g. "ח׳ מנחם אב". Empty when Intl lacks the calendar. */
export function hebDate(ymd: string): string {
  const { dayF } = formatters();
  if (!_supported || !dayF) return "";
  const d = noonUtc(ymd);
  const day = gematriaDay(parseInt(dayF.format(d), 10) || 0);
  const month = hebMonthName(d);
  if (!day || !month) return "";
  return `${day} ${month}`;
}

/** Hebrew year label, e.g. "תשפ״ו". Empty when unsupported. */
export function hebYear(ymd: string): string {
  const { yearF } = formatters();
  if (!_supported || !yearF) return "";
  return yearF.format(noonUtc(ymd));
}

/** Gregorian DD/MM/YYYY. */
export function gregHe(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${d}/${m}/${y}`;
}

/**
 * Full dual-calendar label for a single day:
 *   "יום שני · ח׳ מנחם אב · 21/07/2026"
 * Falls back to weekday + Gregorian if the Hebrew calendar is unavailable.
 */
export function dayLabel(ymd: string): string {
  const heb = hebDate(ymd);
  const parts = [weekdayHe(ymd), heb, gregHe(ymd)].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Dual-calendar label for an inclusive range:
 *   "ח׳–י״ד מנחם אב · 21/07–27/07/2026"
 * When the two ends span different Hebrew months/years the full label of each
 * end is shown instead. Falls back to a Gregorian range if unsupported.
 */
export function rangeLabel(startYmd: string, endYmd: string): string {
  const greg = `${gregHe(startYmd)}–${gregHe(endYmd)}`;
  if (!_supported) return greg;
  const { dayF } = formatters();
  if (!dayF) return greg;
  const sD = noonUtc(startYmd);
  const eD = noonUtc(endYmd);
  const sMonth = hebMonthName(sD);
  const eMonth = hebMonthName(eD);
  const sYear = hebYear(startYmd);
  const eYear = hebYear(endYmd);
  const sDay = gematriaDay(parseInt(dayF.format(sD), 10) || 0);
  const eDay = gematriaDay(parseInt(dayF.format(eD), 10) || 0);

  let heb: string;
  if (sMonth === eMonth && sYear === eYear) {
    heb = `${sDay}–${eDay} ${sMonth}`;
  } else {
    heb = `${sDay} ${sMonth} – ${eDay} ${eMonth}`;
  }
  return heb ? `${heb} · ${greg}` : greg;
}
