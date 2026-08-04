"use client";

/**
 * DaySchedulePopover — the compact day-picker for the מהיר·3·1 method.
 *
 * A tiny trigger button on a medium/big task row. Clicking opens a popover with
 * the shared DayCapacityCalendar, each day tinted by how full it already is for
 * THIS task's size (green = free · yellow = partial · red = full, per the user's
 * medium/big quota). Picking a day commits the task to it (planned_for); the
 * calendar defaults to today when today has room, else jumps to the next free
 * day (soft guidance — a full day is still selectable). Quick tasks never get
 * this — they are always "today".
 *
 * The capacity fetch, colouring, and calendar all live in DayCapacityCalendar
 * (shared with ManualTaskInput's create-time day-picker).
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, CalendarCheck } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  DayCapacityCalendar,
  useDayCapacity,
  dayStateOf,
  firstFreeDay,
  type Capacity,
} from "./DayCapacityCalendar";
import { cn } from "@/lib/utils";
import { dueLabel } from "./DueDateChip";

export function DaySchedulePopover({
  size,
  plannedFor,
  dueDate,
  onSchedule,
  className,
}: {
  size: "medium" | "big";
  /** The task's current planned_for (null = not committed to any day). */
  plannedFor: string | null;
  /** The task's hard due date, if any — a chosen day past it gets a soft warning. */
  dueDate: string | null;
  /** Commit the task to `date`, or null to remove it from its day. */
  onSchedule: (date: string | null) => void;
  className?: string;
}) {
  const t = useTranslations("tasks.daySchedule");
  const { cap, loading, load } = useDayCapacity();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  /** True when we defaulted to a later day because today was already full. */
  const [bumpedFromToday, setBumpedFromToday] = useState(false);

  const loadCapacity = useCallback(async () => {
    const c = await load();
    if (!c) return;
    // Default the selection: keep an existing future commitment; else today if
    // it has room; else the next non-full day (soft guidance).
    if (plannedFor && plannedFor >= c.today) {
      setDraft(plannedFor);
      setBumpedFromToday(false);
    } else {
      const next = firstFreeDay(c, size);
      setDraft(next);
      setBumpedFromToday(next !== c.today);
    }
  }, [plannedFor, size, load]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Refetch on every open: capacity is a cheap read and may have changed since
    // the last open (other tasks scheduled), and reloading recomputes the
    // default day (today-if-free, else next free) consistently.
    if (next) void loadCapacity();
  }

  function pick(date: string | null) {
    setOpen(false);
    onSchedule(date);
  }

  const isPlanned = !!plannedFor;
  const draftState = (c: Capacity) => (draft ? dayStateOf(c, draft, size) : null);
  const pastDeadline = !!dueDate && !!draft && draft > dueDate;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          title={isPlanned ? t("plannedHint", { date: dueLabel(plannedFor!) }) : t("addHint")}
          aria-label={isPlanned ? t("plannedHint", { date: dueLabel(plannedFor!) }) : t("addHint")}
          className={cn(
            "flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent",
            className,
          )}
        >
          {isPlanned ? <CalendarCheck className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 px-1 text-[13px] font-semibold" dir="auto">{t("title")}</div>

        {loading ? (
          <div className="w-[16rem] py-8 text-center text-xs text-muted-foreground">{t("loading")}</div>
        ) : (
          <>
            <DayCapacityCalendar
              size={size}
              cap={cap}
              value={draft}
              onSelect={(iso) => { setDraft(iso); setBumpedFromToday(false); }}
            />

            {/* Soft notices below the shared calendar. */}
            {draft && (
              <div className="mt-1 space-y-0.5 px-1 text-center text-[11px]">
                {bumpedFromToday && cap && draftState(cap) !== "full" && (
                  <div className="text-status-warn" dir="auto">{t("bumpedToday")}</div>
                )}
                {pastDeadline && <div className="text-status-late" dir="auto">{t("pastDeadline")}</div>}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-2">
              {isPlanned ? (
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="rounded-md px-2 py-1 text-[11px] font-medium text-status-late hover:bg-accent"
                >
                  {t("remove")}
                </button>
              ) : <span />}
              <button
                type="button"
                disabled={!draft}
                onClick={() => draft && pick(draft)}
                className="rounded-md bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-40"
              >
                {t("commit")}
              </button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
