"use client";

import { useEffect, useState } from "react";

/**
 * Renders a DB timestamp in the VIEWER's local timezone.
 *
 * The admin pages are server components (`force-dynamic`), so a bare
 * `new Date(ts).toLocaleString()` formats against the server's timezone
 * (UTC on Vercel) — showing times that look shifted or "in the future"
 * to an admin sitting in Israel. We format on the client after mount so
 * the browser's own locale + timezone are used. The first render matches
 * the server output (avoiding a hydration mismatch); the effect then
 * rewrites it to local time.
 */
export function LocalDateTime({
  value,
  locale,
  mode = "datetime",
  fallback = "—",
}: {
  value: string | null | undefined;
  locale?: string;
  mode?: "datetime" | "time" | "date";
  fallback?: string;
}) {
  const format = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return fallback;
    const loc = locale === "he" ? "he-IL" : locale === "en" ? "en-US" : undefined;
    if (mode === "time") return d.toLocaleTimeString(loc);
    if (mode === "date") return d.toLocaleDateString(loc);
    return d.toLocaleString(loc);
  };

  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    if (value) setText(format(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, locale, mode]);

  if (!value) return <>{fallback}</>;
  // Server render + first client render use the same (server-tz) string to
  // keep hydration happy; the effect above swaps in the local-tz string.
  return <span suppressHydrationWarning>{text ?? format(value)}</span>;
}
