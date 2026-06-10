"use client";

import { useTranslations } from "next-intl";
import { Zap, Clock, Home, Hourglass, ArrowDown, ArrowUp, AlarmClockCheck, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContextButton } from "./ContextPanel";
import { DueDateChip } from "./DueDateChip";
import {
  effectiveDeadline,
  sittingWorkdays,
  AGING_LABEL_WORKDAYS,
  type BlockedDays,
} from "@/lib/workdays";
import type { Task, TaskNeed } from "@/types/task";

export type RowZone = "desk" | "waiting" | "done";

/**
 * The unified compact task row — one component for the desk columns, the
 * waiting list and the completed list. Identity metadata lives behind the
 * single context button (✨/📋); the row itself carries only what drives the
 * "what do I do now" decision: ✓, title, size, context, deadline.
 */
export function TaskRow({
  task,
  locale,
  zone,
  blocked,
  /** Unsatisfied plan needs — when non-empty the task can't start: ⏳, no ✓. */
  unsatisfiedNeeds = [],
  /** True when the row sits on the desk by the 3-day rule (no manual position) —
   *  such rows can't be demoted by hand; the date is what put them there. */
  autoPromoted,
  onToggleDone,
  onOpen,
  onSnooze,
  onMove,
  onSizeToggle,
  onDueChange,
}: {
  task: Task;
  locale: string;
  zone: RowZone;
  blocked: BlockedDays;
  unsatisfiedNeeds?: TaskNeed[];
  autoPromoted?: boolean;
  onToggleDone: (task: Task, done: boolean) => void;
  onOpen: (task: Task) => void;
  onSnooze?: (taskId: string) => void;
  /** Move between desk and waiting (manual pin / unpin). */
  onMove?: (taskId: string, toDesk: boolean) => void;
  onSizeToggle?: (taskId: string, size: "quick" | "regular") => void;
  onDueChange?: (taskId: string, date: string | null) => void;
}) {
  const t = useTranslations("tasks");
  const title = locale === "he" && task.title_he ? task.title_he : task.title;
  const isBlocked = unsatisfiedNeeds.length > 0;
  const isDone = zone === "done";
  const isPlan = !!task.plan_id;
  const deadline = effectiveDeadline(task);
  const constrained = !!(task.latest_finish && task.due_date && task.latest_finish < task.due_date);
  const sitting = zone === "waiting" ? sittingWorkdays(task, blocked) : 0;
  const woke = !!task.woke_from_snooze_at;

  return (
    <div
      onClick={() => onOpen(task)}
      className={cn(
        "group flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-card px-2.5 py-2 cursor-pointer transition-colors hover:bg-accent/30",
        isDone && "opacity-70",
        task.has_unread_update && "border-s-2 border-s-status-warn",
        task.status === "pending_completion" && "border-s-4 border-s-status-ok",
      )}
    >
      {/* ✓ / blocked / done */}
      {isBlocked && !isDone ? (
        <span
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-status-warn-bg text-status-warn"
          title={t("row.blockedHint", { titles: unsatisfiedNeeds.map((n) => n.title).join(", ") })}
        >
          <Hourglass className="h-3.5 w-3.5" />
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleDone(task, !isDone); }}
          title={isDone ? t("row.reopen") : t("actions.complete")}
          className={cn(
            "flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border-2 text-[12px] transition-colors",
            isDone
              ? "border-status-ok bg-status-ok text-white hover:bg-transparent hover:text-transparent hover:border-muted-foreground/60"
              : "border-muted-foreground/40 text-transparent hover:border-status-ok hover:text-status-ok",
          )}
        >
          ✓
        </button>
      )}

      {/* Title */}
      <span
        dir="auto"
        className={cn(
          "min-w-0 flex-1 truncate text-[14px] font-medium",
          isDone && "text-muted-foreground line-through",
        )}
      >
        {title}
      </span>

      {/* Context button (✨/📋) — its open panel renders as a full-width sibling */}
      <ContextButton task={task} locale={locale} />

      {/* Quiet indicator chips */}
      {task.context === "home" && (
        <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label={t("row.contextHome")} />
      )}
      {task.recurrence_rule && (
        <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("row.recurring")} />
      )}
      {isPlan && task.is_critical && !isDone && (
        <span className="shrink-0 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
          {t("row.critical")}
        </span>
      )}
      {woke && !isDone && (
        <span className="flex shrink-0 items-center gap-0.5 rounded bg-status-warn-bg px-1.5 py-px text-[9px] font-bold text-status-warn" title={t("row.wokeHint")}>
          <AlarmClockCheck className="h-3 w-3" />
          {t("row.wokeChip")}
        </span>
      )}
      {sitting >= AGING_LABEL_WORKDAYS && (
        <span className="shrink-0 rounded bg-secondary px-1.5 py-px text-[10px] text-muted-foreground" title={t("row.sittingHint")}>
          {t("row.sitting", { days: sitting })}
        </span>
      )}

      {/* Size toggle — ⚡ filled when quick */}
      {onSizeToggle && !isDone && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSizeToggle(task.id, task.size === "quick" ? "regular" : "quick");
          }}
          title={task.size === "quick" ? t("row.sizeQuickHint") : t("row.sizeRegularHint")}
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors",
            task.size === "quick"
              ? "bg-status-warn-bg text-status-warn"
              : "text-muted-foreground/40 hover:text-muted-foreground",
          )}
        >
          <Zap className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Deadline chip — effective deadline, locked for plan tasks */}
      {!isDone && (
        <DueDateChip
          deadline={deadline}
          locale={locale}
          blocked={blocked}
          locked={isPlan}
          constrained={constrained}
          onChange={onDueChange ? (d) => onDueChange(task.id, d) : undefined}
        />
      )}

      {/* Hover actions */}
      {!isDone && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {onSnooze && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSnooze(task.id); }}
              title={t("actions.snooze")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
          )}
          {/* A blocked task can't sit on the desk (the partition keeps it in
              waiting regardless of pin), so don't offer a no-op arrow. */}
          {onMove && zone === "waiting" && !isBlocked && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMove(task.id, true); }}
              title={t("row.moveToDesk")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
          )}
          {onMove && zone === "desk" && !autoPromoted && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMove(task.id, false); }}
              title={t("row.moveToWaiting")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
