/**
 * Hebrew (Jewish) calendar helpers built on the browser's Intl Hebrew
 * calendar — no external dependency. They power the dual-calendar date
 * picker (Gregorian ⇄ עברי), so the user can pick a day on the Hebrew
 * luach the way chabad.org's calendar works.
 *
 * Intl handles all the hard parts (leap months, variable month lengths,
 * Adar I/II), so the month grid is derived by walking Gregorian days and
 * watching where the Hebrew month boundary falls. Day numerals are rendered
 * in gematria via `gematriaDay` from smrtplan/dates.
 */

let _dayF: Intl.DateTimeFormat | null = null;
let _monthF: Intl.DateTimeFormat | null = null;
let _yearF: Intl.DateTimeFormat | null = null;
let _supported: boolean | null = null;

function formatters() {
  if (_supported === null) {
    try {
      _dayF = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric" });
      _monthF = new Intl.DateTimeFormat("he-u-ca-hebrew", { month: "long" });
      _yearF = new Intl.DateTimeFormat("he-u-ca-hebrew", { year: "numeric" });
      // A runtime can return Latin digits / empty if the Hebrew calendar
      // isn't bundled; probe once so callers can fall back to Gregorian-only.
      _supported = /\d/.test(_dayF.format(new Date()));
    } catch {
      _supported = false;
    }
  }
  return { dayF: _dayF, monthF: _monthF, yearF: _yearF };
}

/** Whether the runtime can render the Hebrew calendar at all. */
export function hebrewCalendarSupported(): boolean {
  formatters();
  return _supported === true;
}

/** Hebrew day-of-month as a plain integer (1–30). */
export function hebDayNum(d: Date): number {
  const { dayF } = formatters();
  if (!dayF) return 0;
  return parseInt(dayF.format(d), 10) || 0;
}

/** Hebrew month name, e.g. "סיון" / "אדר א׳". Empty when unsupported. */
export function hebMonthName(d: Date): string {
  const { monthF } = formatters();
  if (!monthF) return "";
  // Some ICU builds prefix the month with the Hebrew preposition "ב".
  return monthF.format(d).replace(/^ב/, "");
}

/** Hebrew year label, e.g. "תשפ״ו". Empty when unsupported. */
export function hebYearLabel(d: Date): string {
  const { yearF } = formatters();
  if (!yearF) return "";
  return yearF.format(d);
}

/** Midnight-normalised copy, so day math never drifts on DST boundaries. */
function dayOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The full set of Gregorian dates that make up the Hebrew month containing
 * `anchor`, plus its display labels. Walks back to the 1st of the month,
 * then forward until the month name (or year) changes.
 */
export function hebMonthGrid(anchor: Date): {
  firstDay: Date;
  days: Date[];
  monthName: string;
  yearLabel: string;
} {
  const first = dayOnly(anchor);
  // Step back to the 1st of this Hebrew month.
  let guard = 0;
  while (hebDayNum(first) !== 1 && guard++ < 40) {
    first.setDate(first.getDate() - 1);
  }
  const monthName = hebMonthName(first);
  const yearLabel = hebYearLabel(first);

  const days: Date[] = [];
  const cur = new Date(first);
  while (
    hebMonthName(cur) === monthName &&
    hebYearLabel(cur) === yearLabel &&
    days.length < 40
  ) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return { firstDay: first, days, monthName, yearLabel };
}
