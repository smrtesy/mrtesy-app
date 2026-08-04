"use client";

/**
 * DayCapacityCalendar — the shared מהיר·3·1 day-picker calendar.
 *
 * A HebrewCalendar tinted by how full each day already is for a given task size
 * (green = free · yellow = partial · red = full, per the user's medium/big
 * quota), plus a legend and the selected day's load line. A full day is still
 * selectable — the quota is soft.
 *
 * Extracted so the SAME calendar + capacity logic is reused by:
 *  - DaySchedulePopover (rescheduling an existing medium/big task), and
 *  - ManualTaskInput (choosing a day when today is already full at creation).
 *
 * Capacity comes from GET /api/tasks/day-capacity (see useDayCapacity below).
 * `today` in the response is the user's own local date (New York default), so
 * past days disable correctly regardless of the browser timezone.
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { HebrewCalendar } from "@/components/ui/hebrew-calendar";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";

export type DayLoad = { date: string; medium_used: number; big_used: number };
export type Capacity = { today: string; medium_quota: number; big_quota: number; days: DayLoad[] };
export type CapSize = "medium" | "big";
export type DayState = "free" | "partial" | "full";

export const STATE_BG: Record<DayState, string> = {
  free: "bg-status-ok-bg",
  partial: "bg-status-warn-bg",
  full: "bg-status-late-bg",
};

/** Shift an ISO date (YYYY-MM-DD) by n days, timezone-independently. */
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today as the browser sees it — only the request window anchor; the server's
 *  own `today` (user timezone) drives the min bound and "today" affordances. */
export function browserTodayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function quotaForSize(c: Capacity, size: CapSize): number {
  return size === "big" ? c.big_quota : c.medium_quota;
}

export function usedOnDay(c: Capacity, iso: string, size: CapSize): number {
  const d = c.days.find((x) => x.date === iso);
  if (!d) return 0;
  return size === "big" ? d.big_used : d.medium_used;
}

export function dayStateOf(c: Capacity, iso: string, size: CapSize): DayState {
  const used = usedOnDay(c, iso, size);
  const quota = quotaForSize(c, size);
  if (used <= 0) return "free";
  if (used >= quota) return "full";
  return "partial";
}

/** today if it has room for `size`, else the next non-full day within 90 days
 *  (soft guidance — a full day is still selectable). Falls back to today. */
export function firstFreeDay(c: Capacity, size: CapSize): string {
  if (dayStateOf(c, c.today, size) !== "full") return c.today;
  for (let i = 1; i <= 90; i++) {
    const cand = addDaysISO(c.today, i);
    if (dayStateOf(c, cand, size) !== "full") return cand;
  }
  return c.today;
}

/** Lazy capacity loader for the day-picker. Returns the fetched Capacity (or
 *  null on a network/auth hiccup) so callers can compute a default day. */
export function useDayCapacity() {
  const [cap, setCap] = useState<Capacity | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (): Promise<Capacity | null> => {
    setLoading(true);
    try {
      const from = addDaysISO(browserTodayISO(), -1);
      const to = addDaysISO(browserTodayISO(), 90);
      const c = await api<Capacity>(`/api/tasks/day-capacity?from=${from}&to=${to}`);
      setCap(c);
      return c;
    } catch {
      setCap(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  return { cap, loading, load };
}

/** The calendar + legend + selected-day load line. Presentational: the caller
 *  owns `value`, `onSelect`, and any extra notices below it. */
export function DayCapacityCalendar({
  size,
  cap,
  value,
  onSelect,
}: {
  size: CapSize;
  cap: Capacity | null;
  value: string | null;
  onSelect: (iso: string) => void;
}) {
  const t = useTranslations("tasks.daySchedule");
  const quota = cap ? quotaForSize(cap, size) : size === "big" ? 1 : 3;
  const selUsed = cap && value ? usedOnDay(cap, value, size) : 0;
  const loadKey = size === "big" ? "loadBig" : "loadMedium";

  return (
    <>
      <HebrewCalendar
        value={value}
        onSelect={onSelect}
        min={cap?.today}
        max={cap ? addDaysISO(cap.today, 90) : undefined}
        dayMeta={
          cap
            ? (iso) => {
                if (iso < cap.today) return undefined;
                const st = dayStateOf(cap, iso, size);
                const used = usedOnDay(cap, iso, size);
                return { className: STATE_BG[st], title: t(loadKey, { used, quota }) };
              }
            : undefined
        }
      />

      {/* Legend — free / partial / full. */}
      <div className="mt-1 flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1"><i className={cn("h-2.5 w-2.5 rounded-sm", STATE_BG.free)} />{t("legendFree")}</span>
        <span className="flex items-center gap-1"><i className={cn("h-2.5 w-2.5 rounded-sm", STATE_BG.partial)} />{t("legendPartial")}</span>
        <span className="flex items-center gap-1"><i className={cn("h-2.5 w-2.5 rounded-sm", STATE_BG.full)} />{t("legendFull")}</span>
      </div>

      {/* The chosen day's load. */}
      {value && (
        <div className="mt-1.5 px-1 text-center text-[11px] text-muted-foreground" dir="auto">
          {t(loadKey, { used: selUsed, quota })}
        </div>
      )}
    </>
  );
}
