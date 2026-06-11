"use client";

import { useTranslations } from "next-intl";
import { Zap, Clock, Home, Hourglass, ArrowDown, ArrowUp, AlarmClockCheck, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { DueDateChip } from "./DueDateChip";
import {
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
  // Show the date the user actually set (due_date) as the primary deadline, so a
  // due date edited on the plan board shows here verbatim — matching the board.
  // When the engine's latest_finish pulls earlier, `constrained` flags it with ⚠
  // (rather than silently replacing the shown date with the earlier one).
  const deadline = task.due_date ?? task.latest_finish ?? null;
  const constrained = !!(task.latest_finish && task.due_date && task.latest_finish < task.due_date);
  const sitting = zone === "waiting" ? sittingWorkdays(task, blocked) : 0;
  const woke = !!task.woke_from_snooze_at;
  // Plan/stage label (attached at runtime by /api/plan/my-tasks).
  const planLabel = isPlan
    ? [
        locale === "en" ? task.plan_title_en || task.plan_title_he : task.plan_title_he || task.plan_title_en,
        locale === "en" ? task.stage_name_en || task.stage_name_he : task.stage_name_he || task.stage_name_en,
      ].filter(Boolean).join(" / ")
    : "";

  return (
    <div
      onClick={() => onOpen(task)}
      className={cn(
        // flex-nowrap with fixed-width trailing slots keeps the size/date/action
        // columns aligned down the whole list (the title absorbs all variance).
        "group flex flex-nowrap items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 cursor-pointer transition-colors hover:bg-accent/30",
        isDone && "opacity-70",
        task.has_unread_update && "border-s-2 border-s-status-warn",
        task.status === "pending_completion" && "border-s-4 border-s-status-ok",
      )}
    >
      {/* ✓ / blocked / done — compact, leaving room for the title */}
      {isBlocked && !isDone ? (
        <span
          className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-status-warn-bg text-status-warn"
          title={t("row.blockedHint", { titles: unsatisfiedNeeds.map((n) => n.title).join(", ") })}
        >
          <Hourglass className="h-3 w-3" />
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleDone(task, !isDone); }}
          title={isDone ? t("row.reopen") : t("actions.complete")}
          className={cn(
            "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 text-[10px] transition-colors",
            isDone
              ? "border-status-ok bg-status-ok text-white hover:bg-transparent hover:text-transparent hover:border-muted-foreground/60"
              : "border-muted-foreground/40 text-transparent hover:border-status-ok hover:text-status-ok",
          )}
        >
          ✓
        </button>
      )}

      {/* Title + inline indicators — the only flexible region. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          dir="auto"
          className={cn(
            "min-w-0 truncate text-[13px] font-medium",
            isDone && "text-muted-foreground line-through",
          )}
        >
          {title}
        </span>
        {task.context === "home" && (
          <Home className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("row.contextHome")} />
        )}
        {task.recurrence_rule && (
          <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("row.recurring")} />
        )}
        {woke && !isDone && (
          <AlarmClockCheck className="h-3 w-3 shrink-0 text-status-warn" aria-label={t("row.wokeHint")} />
        )}
        {planLabel && (
          <span className="shrink-0 rounded bg-accent px-1.5 py-px text-[10px] text-accent-foreground">
            {planLabel}
          </span>
        )}
        {sitting >= AGING_LABEL_WORKDAYS && (
          <span className="shrink-0 rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground" title={t("row.sittingHint")}>
            {t("row.sitting", { days: sitting })}
          </span>
        )}
      </span>

      {/* ── fixed trailing columns ──────────────────────────────────────── */}

      {/* Size toggle — ⚡ filled when quick */}
      <span className="flex w-5 shrink-0 justify-center">
        {onSizeToggle && !isDone && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSizeToggle(task.id, task.size === "quick" ? "regular" : "quick");
            }}
            title={task.size === "quick" ? t("row.sizeQuickHint") : t("row.sizeRegularHint")}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded transition-colors",
              task.size === "quick"
                ? "bg-status-warn-bg text-status-warn"
                : "text-muted-foreground/40 hover:text-muted-foreground",
            )}
          >
            <Zap className="h-3 w-3" />
          </button>
        )}
      </span>

      {/* Deadline chip — fixed column with breathing room from the ⚡ slot,
          end-aligned so dates line up down the list. */}
      {!isDone && (
        <span className="ms-2 flex w-[110px] shrink-0 justify-end">
          <DueDateChip
            deadline={deadline}
            locale={locale}
            blocked={blocked}
            locked={isPlan}
            constrained={constrained}
            onChange={onDueChange ? (d) => onDueChange(task.id, d) : undefined}
          />
        </span>
      )}

      {/* Snooze / move — always visible but faint; full strength on hover. */}
      {!isDone && (
        <span className="flex w-12 shrink-0 items-center justify-end gap-0.5 opacity-35 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {onSnooze && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onSnooze(task.id); }}
              title={t("actions.snooze")}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <Clock className="h-3 w-3" />
            </button>
          )}
          {/* A blocked task can't sit on the desk (the partition keeps it in
              waiting regardless of pin), so don't offer a no-op arrow. */}
          {onMove && zone === "waiting" && !isBlocked && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMove(task.id, true); }}
              title={t("row.moveToDesk")}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <ArrowUp className="h-3 w-3" />
            </button>
          )}
          {onMove && zone === "desk" && !autoPromoted && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onMove(task.id, false); }}
              title={t("row.moveToWaiting")}
              className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <ArrowDown className="h-3 w-3" />
            </button>
          )}
        </span>
      )}
    </div>
  );
}
