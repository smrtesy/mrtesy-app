"use client";

import { useTranslations } from "next-intl";
import { Zap, Clock, Home, MapPin, Hourglass, ArrowDown, ArrowUp, AlarmClockCheck, Repeat, Bot, Plus, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { DueDateChip } from "./DueDateChip";
import {
  sittingWorkdays,
  AGING_LABEL_WORKDAYS,
  type BlockedDays,
} from "@/lib/workdays";
import type { Task, TaskNeed } from "@/types/task";

export type RowZone = "desk" | "important" | "waiting" | "done";

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
  onPlanToggle,
  plannedToday,
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
  onSizeToggle?: (taskId: string, size: "quick" | "medium" | "big") => void;
  onDueChange?: (taskId: string, date: string | null, time: string | null) => void;
  /** Add to / remove from today's plan (planned_for). Not shown for quick. */
  onPlanToggle?: (taskId: string, addToToday: boolean) => void;
  plannedToday?: boolean;
}) {
  const t = useTranslations("tasks");
  const tClaude = useTranslations("claude");
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
        // Two stacked rows: the title gets the full first row (never truncated),
        // and all the labels/icons (⚡ size · deadline · snooze/move) drop to a
        // second row indented under the title.
        "group flex flex-col gap-1 rounded-lg border bg-card px-2.5 py-1.5 cursor-pointer transition-colors hover:bg-accent/30",
        isDone && "opacity-70",
        task.has_unread_update && "border-s-2 border-s-status-warn",
        task.status === "pending_completion" && "border-s-4 border-s-status-ok",
      )}
    >
      {/* ── Row 1: ✓ + the full title (no truncation) ───────────────────── */}
      <div className="flex items-start gap-2">
        {/* ✓ / blocked / done */}
        {isBlocked && !isDone ? (
          <span
            className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded bg-status-warn-bg text-status-warn"
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
              "mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border-2 text-[10px] transition-colors",
              isDone
                ? "border-status-ok bg-status-ok text-white hover:bg-transparent hover:text-transparent hover:border-muted-foreground/60"
                : "border-muted-foreground/40 text-transparent hover:border-status-ok hover:text-status-ok",
            )}
          >
            ✓
          </button>
        )}

        {/* Title + inline indicators — full width, wraps instead of truncating. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <span
            dir="auto"
            className={cn(
              "min-w-0 text-[13px] font-medium break-words",
              isDone && "text-muted-foreground line-through",
            )}
          >
            {title}
          </span>
          {task.context === "home" && (
            <Home className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("row.contextHome")} />
          )}
          {task.context === "outside" && (
            <MapPin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("row.contextOutside")} />
          )}
          {task.recurrence_rule && (
            <Repeat className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("row.recurring")} />
          )}
          {woke && !isDone && (
            <AlarmClockCheck className="h-3 w-3 shrink-0 text-status-warn" aria-label={t("row.wokeHint")} />
          )}
          {task.claude_waiting_since && !isDone && (
            <Bot className="h-3 w-3 shrink-0 text-primary" aria-label={tClaude("chipLabel")} />
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
      </div>

      {/* ── Row 2: ⚡ size · deadline · snooze/move — indented under the title.
           Only for non-done rows (a done row has none of these). ───────── */}
      {!isDone && (
        <div className="flex items-center gap-2 ps-[26px]">
          {/* Size toggle — ⚡ filled when quick. Events (meetings) have no
              effort level, so the toggle is hidden for them. */}
          {onSizeToggle && task.task_type !== "meeting" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSizeToggle(task.id, task.size === "quick" ? "medium" : "quick");
              }}
              title={task.size === "quick" ? t("row.sizeQuickHint") : t("row.sizeRegularHint")}
              className={cn(
                "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
                task.size === "quick"
                  ? "bg-status-warn-bg text-status-warn"
                  : "text-muted-foreground/40 hover:text-muted-foreground",
              )}
            >
              <Zap className="h-3 w-3" />
            </button>
          )}

          {/* Deadline chip */}
          <DueDateChip
            deadline={deadline}
            time={task.due_date ? task.due_time : null}
            locale={locale}
            blocked={blocked}
            locked={isPlan}
            constrained={constrained}
            onChange={onDueChange ? (d, tm) => onDueChange(task.id, d, tm) : undefined}
          />

          <div className="flex-1" />

          {/* Plan / snooze / move — always visible but faint; full on hover. */}
          <span className="flex shrink-0 items-center gap-0.5 opacity-35 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {/* Add to / remove from today's plan (medium/big only — quick is always today). */}
            {onPlanToggle && task.size !== "quick" && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onPlanToggle(task.id, !plannedToday); }}
                title={plannedToday ? t("row.removeFromToday") : t("row.addToToday")}
                className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                {plannedToday ? <Minus className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
              </button>
            )}
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
            {onMove && (zone === "waiting" || zone === "important") && !isBlocked && (
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
        </div>
      )}
    </div>
  );
}
