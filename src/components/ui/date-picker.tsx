"use client";

/**
 * Drop-in replacement for `<input type="date">` that opens the dual-calendar
 * widget (Gregorian + עברי, toggled by ע/E) instead of the browser's native
 * picker. Built on Radix Popover so it composes correctly when rendered inside
 * a Dialog (a click on the calendar dismisses only the popover, never the
 * surrounding dialog) and never gets clipped by table/overflow containers.
 *
 * The value contract matches a native date input: `value` is an ISO
 * `YYYY-MM-DD` string and `onChange` is called with the new ISO string.
 */

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarDays } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseISO, hebDate } from "@/lib/smrtplan/dates";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { HebrewCalendar } from "@/components/ui/hebrew-calendar";

/** Human label for the trigger: localized Gregorian date + Hebrew date when available. */
function formatValue(iso: string, locale: string): string {
  const d = parseISO(iso);
  const greg = d.toLocaleDateString(locale === "en" ? "en-US" : "he-IL", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
  });
  const heb = hebDate(d);
  return heb ? `${greg} · ${heb}` : greg;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled,
  className,
  id,
  placeholder,
  autoOpen,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  placeholder?: string;
  /** Open the calendar immediately on mount (for inline cell editing). */
  autoOpen?: boolean;
  /** Fired when the calendar closes (outside click, Escape, or after a pick). */
  onClose?: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("common.calendar");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpen && !disabled) setOpen(true);
  }, [autoOpen, disabled]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) onClose?.();
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")} dir="auto">
            {value ? formatValue(value, locale) : placeholder ?? t("pick")}
          </span>
          <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <HebrewCalendar
          value={value || null}
          min={min}
          max={max}
          onSelect={(iso) => {
            onChange(iso);
            handleOpenChange(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
