"use client";

/**
 * Dual-calendar month grid — Gregorian (לועזי) and Hebrew (עברי), with a
 * ע/E toggle in the top-left that flips between them (chabad.org-style luach).
 *
 * Controlled: `value` is an ISO `YYYY-MM-DD` string (always Gregorian — the
 * Hebrew view is purely a different lens onto the same underlying day) and
 * `onSelect` fires with the chosen ISO. The chosen calendar mode is persisted
 * to localStorage so the preference sticks across every picker in the app.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { isoOf, parseISO, gematriaDay, gregMonthLabel } from "@/lib/smrtplan/dates";
import {
  hebrewCalendarSupported,
  hebDayNum,
  hebMonthGrid,
} from "@/lib/hebcal";

type Mode = "heb" | "greg";
const MODE_KEY = "smrtesy:calMode";

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function HebrewCalendar({
  value,
  onSelect,
  min,
  max,
  className,
}: {
  value: string | null;
  onSelect: (iso: string) => void;
  min?: string;
  max?: string;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("common.calendar");
  const hebOk = hebrewCalendarSupported();

  const today = useMemo(() => startOfDay(new Date()), []);
  const selected = useMemo(() => (value ? parseISO(value) : null), [value]);

  const [mode, setMode] = useState<Mode>(
    hebOk && locale !== "en" ? "heb" : "greg",
  );
  const [cursor, setCursor] = useState<Date>(selected ?? today);

  // Restore the persisted calendar preference once on mount.
  useEffect(() => {
    if (!hebOk) return;
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === "heb" || saved === "greg") setMode(saved);
    } catch {
      /* private mode / no storage — keep the locale default */
    }
  }, [hebOk]);

  // Re-centre when the bound value changes from outside.
  useEffect(() => {
    if (selected) setCursor(selected);
  }, [selected]);

  function changeMode(next: Mode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  const inRange = (iso: string) =>
    (!min || iso >= min) && (!max || iso <= max);

  // Weekday header letters. Both calendars share the Gregorian week; only the
  // labels follow the locale. Sunday-first to match the Israeli week.
  const weekdays =
    locale === "en"
      ? ["S", "M", "T", "W", "T", "F", "S"]
      : ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

  // Build the grid + header for the active calendar.
  let headerLabel: string;
  let leadingBlanks: number;
  let cells: { date: Date; label: string }[];

  if (mode === "heb" && hebOk) {
    const grid = hebMonthGrid(cursor);
    headerLabel = `${grid.monthName} ${grid.yearLabel}`.trim();
    leadingBlanks = grid.firstDay.getDay();
    cells = grid.days.map((d) => ({
      date: d,
      label: gematriaDay(hebDayNum(d)),
    }));
  } else {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const count = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      0,
    ).getDate();
    headerLabel = gregMonthLabel(cursor, locale);
    leadingBlanks = first.getDay();
    cells = Array.from({ length: count }, (_, i) => {
      const d = new Date(cursor.getFullYear(), cursor.getMonth(), i + 1);
      return { date: d, label: String(i + 1) };
    });
  }

  function goPrev() {
    if (mode === "heb" && hebOk) {
      const { firstDay } = hebMonthGrid(cursor);
      const prev = new Date(firstDay);
      prev.setDate(prev.getDate() - 1);
      setCursor(prev);
    } else {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1));
    }
  }

  function goNext() {
    if (mode === "heb" && hebOk) {
      const { days } = hebMonthGrid(cursor);
      const next = new Date(days[days.length - 1]);
      next.setDate(next.getDate() + 1);
      setCursor(next);
    } else {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1));
    }
  }

  const gridDir = mode === "heb" && hebOk ? "rtl" : "ltr";

  return (
    <div className={cn("w-[16rem] select-none p-2", className)}>
      {/* Header: ע/E toggle pinned physically left, month nav on the right. */}
      <div className="mb-2 flex items-center gap-1" dir="ltr">
        {hebOk && (
          <div className="flex overflow-hidden rounded-md border text-[11px] font-bold leading-none">
            <button
              type="button"
              onClick={() => changeMode("heb")}
              aria-pressed={mode === "heb"}
              title={t("hebrew")}
              className={cn(
                "px-1.5 py-1 transition-colors",
                mode === "heb"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              ע
            </button>
            <button
              type="button"
              onClick={() => changeMode("greg")}
              aria-pressed={mode === "greg"}
              title={t("gregorian")}
              className={cn(
                "px-1.5 py-1 transition-colors",
                mode === "greg"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              E
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={goPrev}
          title={t("prevMonth")}
          className="ms-auto rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="min-w-[7.5rem] text-center text-[13px] font-semibold" dir="auto">
          {headerLabel}
        </div>
        <button
          type="button"
          onClick={goNext}
          title={t("nextMonth")}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div dir={gridDir}>
        <div className="grid grid-cols-7 text-center text-[10px] font-medium text-muted-foreground">
          {weekdays.map((w, i) => (
            <div key={i} className="py-1">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <div key={`b${i}`} />
          ))}
          {cells.map(({ date, label }) => {
            const iso = isoOf(date);
            const disabled = !inRange(iso);
            const isSel = selected != null && iso === isoOf(selected);
            const isToday = iso === isoOf(today);
            return (
              <button
                key={iso}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(iso)}
                className={cn(
                  "flex h-8 items-center justify-center rounded-md text-[12.5px] tabular-nums transition-colors",
                  disabled && "cursor-not-allowed opacity-30",
                  !disabled && !isSel && "hover:bg-accent",
                  isSel && "bg-primary font-semibold text-primary-foreground",
                  !isSel && isToday && "font-bold text-primary ring-1 ring-primary/40",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-1.5 flex justify-center">
        <button
          type="button"
          onClick={() => {
            const iso = isoOf(today);
            if (inRange(iso)) onSelect(iso);
            else setCursor(today);
          }}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("today")}
        </button>
      </div>
    </div>
  );
}
