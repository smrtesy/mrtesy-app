"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HebrewCalendar } from "@/components/ui/hebrew-calendar";
import { CalendarPlus, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { dueUrgency, type BlockedDays, type DueUrgency } from "@/lib/workdays";
import { parseISO, gregShort, hebDate } from "@/lib/smrtplan/dates";

/** The system-wide due-date label: "M/D - <hebrew day letters> <hebrew month>",
 *  e.g. "6/9 - כ״ה סיון". Falls back to the Gregorian part alone when the
 *  runtime lacks the Hebrew calendar. */
export function dueLabel(iso: string): string {
  const d = parseISO(iso);
  const heb = hebDate(d);
  return heb ? `${gregShort(d)} - ${heb}` : gregShort(d);
}

const urgencyClasses: Record<DueUrgency, string> = {
  overdue: "bg-status-late-bg text-status-late",
  today: "bg-status-late-bg text-status-late",
  soon: "bg-status-warn-bg text-status-warn",
  far: "bg-status-ok-bg text-status-ok",
};

/**
 * The due-date label: colored by working-day urgency, click-to-edit.
 *
 * - Shows the task's EFFECTIVE deadline (caller passes it — the earlier of
 *   due_date and the plan engine's latest_finish).
 * - No date → a quiet gray chip that invites adding one.
 * - `locked` (plan tasks — only the plan manager may move dates) → display
 *   only, no editor.
 * - `constrained` → the plan engine pulled the deadline earlier than the
 *   task's own due date; marked with ⚠.
 */
export function DueDateChip({
  deadline,
  time,
  blocked,
  locked,
  constrained,
  onChange,
  className,
}: {
  deadline: string | null;
  /** The task's due_time (HH:MM[:SS]) when set — a due date WITH a time is an
   *  event, and the chip renders + edits the clock alongside the date. */
  time?: string | null;
  /** Accepted for call-site symmetry; the label format is locale-independent. */
  locale?: string;
  blocked: BlockedDays;
  locked?: boolean;
  constrained?: boolean;
  onChange?: (date: string | null, time: string | null) => void;
  className?: string;
}) {
  const t = useTranslations("tasks.dueChip");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftTime, setDraftTime] = useState("");

  const urgency = deadline ? dueUrgency(deadline, blocked) : null;
  const editable = !!onChange && !locked;
  // A due date WITH a time reads as an event: show the clock next to the date.
  const timeShort = time ? time.slice(0, 5) : "";
  const isEvent = !!deadline && !!timeShort;

  function open(e: React.MouseEvent) {
    e.stopPropagation();
    if (!editable) return;
    setDraft(deadline ?? "");
    setDraftTime(timeShort);
    setEditing(true);
  }

  function commit(value: string | null) {
    setEditing(false);
    // A time only makes sense with a date; drop it when the date is cleared.
    onChange?.(value, value ? (draftTime || null) : null);
  }

  return (
    <>
      {deadline ? (
        <button
          type="button"
          onClick={open}
          disabled={!editable}
          title={locked ? t("lockedHint") : editable ? t("editHint") : undefined}
          className={cn(
            "shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold",
            urgency ? urgencyClasses[urgency] : "bg-secondary text-muted-foreground",
            editable && "cursor-pointer hover:ring-1 hover:ring-border",
            !editable && "cursor-default",
            className,
          )}
        >
          {isEvent && <CalendarClock className="me-0.5 inline h-3 w-3 align-[-2px]" />}
          {dueLabel(deadline)}
          {timeShort && <span dir="ltr" className="ms-1 font-bold">{timeShort}</span>}
          {constrained && (
            <span className="ms-1 text-status-late" title={t("constrainedHint")}>⚠</span>
          )}
        </button>
      ) : (
        /* No date — a quiet, low-key calendar icon; click adds one. */
        <button
          type="button"
          onClick={open}
          disabled={!editable}
          title={editable ? t("noDateHint") : t("noDate")}
          aria-label={t("noDate")}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/30 transition-colors",
            editable && "cursor-pointer hover:text-muted-foreground hover:bg-accent",
            !editable && "cursor-default",
            className,
          )}
        >
          <CalendarPlus className="h-3.5 w-3.5" />
        </button>
      )}

      <Dialog open={editing} onOpenChange={(o) => !o && setEditing(false)}>
        <DialogContent className="sm:max-w-xs" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="text-start">{t("dialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex justify-center">
            <HebrewCalendar value={draft || null} onSelect={setDraft} />
          </div>
          {/* Optional time — adding one turns the item into an event (a
              reminder that surfaces one working day before). */}
          <div className="flex items-center justify-center gap-2">
            <label className="text-xs font-medium text-muted-foreground">{t("timeLabel")}</label>
            <Input
              type="time"
              value={draftTime}
              onChange={(e) => setDraftTime(e.target.value)}
              disabled={!draft}
              className="w-32"
            />
            {draftTime && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setDraftTime("")}
              >
                {t("clearTime")}
              </Button>
            )}
          </div>
          <p className="text-center text-[11px] text-muted-foreground">{t("timeHint")}</p>
          <DialogFooter className="gap-2">
            {deadline && (
              <Button variant="ghost" className="text-status-late" onClick={() => commit(null)}>
                {t("clear")}
              </Button>
            )}
            <Button onClick={() => commit(draft || null)} disabled={!draft && !deadline}>
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
