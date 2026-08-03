"use client";

/**
 * DaySchedulePopover — the compact day-picker for the מהיר·3·1 method.
 *
 * A tiny trigger button on a medium/big task row. Clicking opens a popover with
 * the shared HebrewCalendar, each day tinted by how full it already is for THIS
 * task's size (green = free · yellow = partial · red = full, per the user's
 * medium/big quota). Picking a day commits the task to it (planned_for); the
 * calendar defaults to today when today has room, else jumps to the next free
 * day (soft guidance — a full day is still selectable). Quick tasks never get
 * this — they are always "today".
 *
 * Capacity is fetched lazily from GET /api/tasks/day-capacity when the popover
 * first opens. `today` in the response is the user's own local date (New York
 * default), so past days disable correctly regardless of the browser timezone.
 */

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, CalendarCheck } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { HebrewCalendar } from "@/components/ui/hebrew-calendar";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { dueLabel } from "./DueDateChip";

type DayLoad = { date: string; medium_used: number; big_used: number };
type Capacity = { today: string; medium_quota: number; big_quota: number; days: DayLoad[] };

type DayState = "free" | "partial" | "full";

const STATE_BG: Record<DayState, string> = {
  free: "bg-status-ok-bg",
  partial: "bg-status-warn-bg",
  full: "bg-status-late-bg",
};

/** Shift an ISO date (YYYY-MM-DD) by n days, timezone-independently. */
function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Today as the browser sees it — only the request window anchor; the server's
 *  own `today` (user timezone) drives the min bound and "today" affordances. */
function browserTodayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

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
  const [open, setOpen] = useState(false);
  const [cap, setCap] = useState<Capacity | null>(null);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  /** True when we defaulted to a later day because today was already full. */
  const [bumpedFromToday, setBumpedFromToday] = useState(false);

  const quotaFor = useCallback(
    (c: Capacity) => (size === "big" ? c.big_quota : c.medium_quota),
    [size],
  );
  const usedOn = useCallback(
    (c: Capacity, iso: string) => {
      const d = c.days.find((x) => x.date === iso);
      if (!d) return 0;
      return size === "big" ? d.big_used : d.medium_used;
    },
    [size],
  );
  const stateOf = useCallback(
    (c: Capacity, iso: string): DayState => {
      const used = usedOn(c, iso);
      const quota = quotaFor(c);
      if (used <= 0) return "free";
      if (used >= quota) return "full";
      return "partial";
    },
    [usedOn, quotaFor],
  );

  const loadCapacity = useCallback(async () => {
    setLoading(true);
    try {
      const from = addDaysISO(browserTodayISO(), -1);
      const to = addDaysISO(browserTodayISO(), 90);
      const c = await api<Capacity>(`/api/tasks/day-capacity?from=${from}&to=${to}`);
      setCap(c);
      // Default the selection: keep an existing future commitment; else today if
      // it has room; else the next non-full day (soft guidance).
      if (plannedFor && plannedFor >= c.today) {
        setDraft(plannedFor);
        setBumpedFromToday(false);
      } else if (stateOf(c, c.today) !== "full") {
        setDraft(c.today);
        setBumpedFromToday(false);
      } else {
        let next = c.today;
        for (let i = 1; i <= 90; i++) {
          const cand = addDaysISO(c.today, i);
          if (stateOf(c, cand) !== "full") { next = cand; break; }
        }
        setDraft(next);
        setBumpedFromToday(next !== c.today);
      }
    } catch {
      // Network / auth hiccup — leave the calendar uncoloured but usable.
      setCap(null);
    } finally {
      setLoading(false);
    }
  }, [plannedFor, stateOf]);

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
  const draftState = cap && draft ? stateOf(cap, draft) : null;
  const draftUsed = cap && draft ? usedOn(cap, draft) : 0;
  const draftQuota = cap ? quotaFor(cap) : size === "big" ? 1 : 3;
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
            <HebrewCalendar
              value={draft}
              onSelect={(iso) => { setDraft(iso); setBumpedFromToday(false); }}
              min={cap?.today}
              max={cap ? addDaysISO(cap.today, 90) : undefined}
              dayMeta={
                cap
                  ? (iso) => {
                      if (iso < cap.today) return undefined;
                      const st = stateOf(cap, iso);
                      const used = usedOn(cap, iso);
                      return {
                        className: STATE_BG[st],
                        title: t(size === "big" ? "loadBig" : "loadMedium", { used, quota: quotaFor(cap) }),
                      };
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

            {/* The chosen day's load + soft notices. */}
            {draft && (
              <div className="mt-1.5 space-y-0.5 px-1 text-center text-[11px]">
                <div className="text-muted-foreground" dir="auto">
                  {t(size === "big" ? "loadBig" : "loadMedium", { used: draftUsed, quota: draftQuota })}
                </div>
                {bumpedFromToday && draftState !== "full" && (
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
