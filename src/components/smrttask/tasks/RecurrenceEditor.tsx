"use client";

/**
 * Google-Calendar-style recurrence editor. Emits the compact recurrence model
 * the backend understands (see server/.../recurrence.ts):
 *
 *   { rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", until: null }
 *   { rule: "FREQ=MONTHLY;BYDAY=2TU",             until: null }   // 2nd Tuesday
 *   { rule: "FREQ=DAILY;COUNT=10",                until: null }   // ends after 10
 *   { rule: "FREQ=WEEKLY",                        until: "2026-12-31" }
 *
 * "Ends after N" rides along as COUNT in the rule; the create route turns it
 * into a concrete recurrence_until. "Ends on date" is emitted as `until`.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { cn } from "@/lib/utils";

export type RecurrenceFreq = "none" | "daily" | "weekly" | "monthly" | "yearly" | "hebrew";
export type RecurrenceModel = { rule: string | null; until: string | null };

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** Locale-appropriate ordinal for the monthly "nth weekday" label. The Hebrew
 *  template wraps it as "ה-{ord}", so a bare number is correct there. */
function ordinalLabel(n: number, locale: string): string {
  if (locale !== "en") return String(n);
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** Anchor weekday + which occurrence-of-the-month a date falls on. */
function monthlyAnchor(dateStr: string) {
  const d = new Date(`${dateStr}T00:00:00`);
  const weekday = d.getDay();
  const dayOfMonth = d.getDate();
  const nth = Math.ceil(dayOfMonth / 7);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const isLast = dayOfMonth + 7 > daysInMonth;
  return { weekday, dayOfMonth, nth, isLast };
}

interface Props {
  /** The task's due date (YYYY-MM-DD) — anchors weekday + monthly options. */
  dueDate: string;
  onChange: (model: RecurrenceModel) => void;
  /** Bump to clear internal state (parent reset). */
  resetKey: number;
}

export function RecurrenceEditor({ dueDate, onChange, resetKey }: Props) {
  const t = useTranslations("manualTask");
  const locale = useLocale();

  const [freq, setFreq] = useState<RecurrenceFreq>("none");
  const [interval, setIntervalN] = useState(1);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [monthlyMode, setMonthlyMode] = useState<"day" | "nth" | "last">("day");
  const [endsMode, setEndsMode] = useState<"never" | "on" | "after">("never");
  const [endDate, setEndDate] = useState("");
  const [count, setCount] = useState(5);

  // Clear everything when the parent form resets.
  useEffect(() => {
    setFreq("none");
    setIntervalN(1);
    setWeekdays([]);
    setMonthlyMode("day");
    setEndsMode("never");
    setEndDate("");
    setCount(5);
  }, [resetKey]);

  const anchor = monthlyAnchor(dueDate || new Date().toISOString().slice(0, 10));

  // Default the weekly day-set to the due date's weekday when first enabled.
  useEffect(() => {
    if (freq === "weekly" && weekdays.length === 0) {
      setWeekdays([anchor.weekday]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq]);

  // Keep the emitted model in sync without re-subscribing on every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    onChangeRef.current(buildModel());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, interval, weekdays, monthlyMode, endsMode, endDate, count, dueDate]);

  function buildModel(): RecurrenceModel {
    if (freq === "none") return { rule: null, until: null };
    const parts: string[] = [];
    const withInterval = freq !== "hebrew" && interval > 1;
    switch (freq) {
      case "daily":   parts.push("FREQ=DAILY"); break;
      case "weekly":  parts.push("FREQ=WEEKLY"); break;
      case "monthly": parts.push("FREQ=MONTHLY"); break;
      case "yearly":  parts.push("FREQ=YEARLY"); break;
      case "hebrew":  parts.push("FREQ=HEBREW_YEARLY"); break;
    }
    if (withInterval) parts.push(`INTERVAL=${interval}`);
    if (freq === "weekly" && weekdays.length) {
      parts.push(`BYDAY=${weekdays.slice().sort((a, b) => a - b).map((d) => WEEKDAY_CODES[d]).join(",")}`);
    }
    if (freq === "monthly") {
      if (monthlyMode === "nth")  parts.push(`BYDAY=${anchor.nth}${WEEKDAY_CODES[anchor.weekday]}`);
      if (monthlyMode === "last") parts.push(`BYDAY=-1${WEEKDAY_CODES[anchor.weekday]}`);
    }
    // Ends after N → COUNT (the create route resolves it into recurrence_until).
    if (endsMode === "after" && count >= 1) parts.push(`COUNT=${count}`);
    const until = endsMode === "on" ? (endDate || null) : null;
    return { rule: parts.join(";"), until };
  }

  function toggleWeekday(day: number) {
    setWeekdays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]));
  }

  const unitKey = { daily: "daysUnit", weekly: "weeksUnit", monthly: "monthsUnit", yearly: "yearsUnit" } as const;
  const freqLabelKey = {
    daily: "freqDaily", weekly: "freqWeekly", monthly: "freqMonthly",
    yearly: "freqYearly", hebrew: "freqHebrew",
  } as const;

  return (
    <div className="space-y-3">
      {/* Frequency */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground shrink-0">{t("recurrenceLabel")}</span>
        <select
          value={freq}
          onChange={(e) => setFreq(e.target.value as RecurrenceFreq)}
          className="flex-1 rounded border px-2 py-1.5 text-sm bg-background"
          dir="auto"
        >
          <option value="none">{t("recurrenceNone")}</option>
          <option value="daily">{t("recur.freqDaily")}</option>
          <option value="weekly">{t("recur.freqWeekly")}</option>
          <option value="monthly">{t("recur.freqMonthly")}</option>
          <option value="yearly">{t("recur.freqYearly")}</option>
          <option value="hebrew">{t("recur.freqHebrew")}</option>
        </select>
      </div>

      {freq !== "none" && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          {/* Interval — "every N <unit>" (not for the Hebrew-date rule) */}
          {freq !== "hebrew" && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("recur.everyLabel")}</span>
              <Input
                type="number"
                min={1}
                value={interval}
                onChange={(e) => setIntervalN(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-16"
                dir="ltr"
              />
              <span className="text-sm text-muted-foreground">
                {interval > 1 ? t(`recur.${unitKey[freq as keyof typeof unitKey]}`) : t(`recur.${freqLabelKey[freq]}`)}
              </span>
            </div>
          )}

          {/* Weekly — day selection */}
          {freq === "weekly" && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("recur.onDaysLabel")}</div>
              <div className="flex flex-wrap gap-1">
                {WEEKDAY_CODES.map((_, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleWeekday(day)}
                    className={cn(
                      "h-9 w-9 rounded-full border text-sm transition-colors",
                      weekdays.includes(day)
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background text-muted-foreground",
                    )}
                    aria-pressed={weekdays.includes(day)}
                  >
                    {t(`weekdayShort.${day}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Monthly — by day-of-month vs by weekday position */}
          {freq === "monthly" && (
            <select
              value={monthlyMode}
              onChange={(e) => setMonthlyMode(e.target.value as "day" | "nth" | "last")}
              className="w-full rounded border px-2 py-1.5 text-sm bg-background"
              dir="auto"
            >
              <option value="day">{t("recur.monthlyByDay", { day: anchor.dayOfMonth })}</option>
              <option value="nth">
                {t("recur.monthlyByWeekday", {
                  weekday: t(`weekdayLong.${anchor.weekday}`),
                  ord: ordinalLabel(anchor.nth, locale),
                })}
              </option>
              {anchor.isLast && (
                <option value="last">
                  {t("recur.monthlyByLastWeekday", { weekday: t(`weekdayLong.${anchor.weekday}`) })}
                </option>
              )}
            </select>
          )}

          {/* Hebrew-date hint */}
          {freq === "hebrew" && (
            <p className="text-[11px] text-muted-foreground" dir="auto">{t("recurrenceHebrewHint")}</p>
          )}

          {/* Ends */}
          <div className="space-y-1.5 border-t pt-2">
            <div className="text-xs font-medium text-muted-foreground">{t("recur.ends")}</div>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="ends" checked={endsMode === "never"} onChange={() => setEndsMode("never")} />
              {t("recur.endsNever")}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="ends" checked={endsMode === "on"} onChange={() => setEndsMode("on")} />
              <span className="shrink-0">{t("recur.endsOn")}</span>
              <div className={cn("flex-1", endsMode !== "on" && "opacity-50 pointer-events-none")}>
                <DatePicker value={endDate} onChange={setEndDate} min={dueDate || undefined} />
              </div>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="ends" checked={endsMode === "after"} onChange={() => setEndsMode("after")} />
              <span className="shrink-0">{t("recur.endsAfter")}</span>
              <Input
                type="number"
                min={1}
                value={count}
                onChange={(e) => setCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                disabled={endsMode !== "after"}
                className="w-16 disabled:opacity-50"
                dir="ltr"
              />
              <span className="text-muted-foreground">{t("recur.occurrences")}</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
