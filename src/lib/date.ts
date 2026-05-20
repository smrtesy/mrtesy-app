/**
 * Date helpers that avoid the classic timezone foot-gun where a bare
 * "YYYY-MM-DD" string (as the DB stores for `due_date`, `start_date`,
 * etc.) is parsed by `new Date()` as midnight UTC, then displayed in the
 * user's local timezone — shifting back a day for any negative UTC
 * offset (US/Americas).
 *
 * `formatDateOnly("2026-05-24", "he-IL")` returns "24.5.2026" everywhere
 * on the planet, because we build a local Date with explicit year/month/
 * day components instead of letting the string parser default to UTC.
 */

/** Parse a "YYYY-MM-DD" date-only string as a LOCAL Date at midnight. */
export function parseDateOnly(value: string): Date {
  // Accept "2026-05-24" and "2026-05-24T..." (strip the time component).
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Format a "YYYY-MM-DD" string for display in the given locale. */
export function formatDateOnly(
  value: string | null | undefined,
  locale: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return "";
  return parseDateOnly(value).toLocaleDateString(
    locale === "he" ? "he-IL" : "en-US",
    options,
  );
}
