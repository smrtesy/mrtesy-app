"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Sun, Plus, Check, AlertTriangle, X } from "lucide-react";
import { todayISO } from "@/lib/workdays";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

// Per-day marker: "the build-your-day banner already auto-appeared today".
// The banner is a quiet once-a-day nudge (per the compact-UI rule); the ☀️
// header button reopens the picker any time, independent of this marker.
const SHOWN_KEY = "smrttask:buildDayShown";

/**
 * "בנה את היום" — the מהיר·3·1 day-tool's manual day-builder
 * (docs/day-tools-plan.md §3.3). All quick tasks enter automatically; here the
 * user consciously picks the day's medium (default 3) + big (default 1). The
 * quota is SOFT — going over warns but never blocks.
 *
 * Renders two surfaces, both opening the same picker dialog:
 *   • a quiet top-of-page banner strip, auto-shown once per day (dismissible);
 *   • the picker dialog itself, also reachable from the ☀️ header button (the
 *     `open`/`onOpenChange` props the parent drives).
 *
 * Picking a task is just planned_for=today (via onPlanToggle); committing the
 * day snapshots it to daily_plans (via onCommit).
 */
export function BuildDayBanner({
  locale,
  mediumCandidates,
  bigCandidates,
  pickedIds,
  mediumQuota,
  bigQuota,
  onPlanToggle,
  onCommit,
  open,
  onOpenChange,
}: {
  locale: string;
  /** All medium tasks eligible to pick (both already-picked and not). */
  mediumCandidates: Task[];
  /** All big tasks eligible to pick. */
  bigCandidates: Task[];
  /** Ids currently planned_for today. */
  pickedIds: Set<string>;
  mediumQuota: number;
  bigQuota: number;
  onPlanToggle: (taskId: string, addToToday: boolean) => void;
  /** Snapshot the committed day to daily_plans. */
  onCommit: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("tasks.buildDay");
  const [showStrip, setShowStrip] = useState(false);

  useEffect(() => {
    // Auto-show the strip at most once per calendar day.
    setShowStrip(localStorage.getItem(SHOWN_KEY) !== todayISO());
  }, []);

  const dismissStrip = () => {
    localStorage.setItem(SHOWN_KEY, todayISO());
    setShowStrip(false);
  };

  const openPicker = () => {
    localStorage.setItem(SHOWN_KEY, todayISO());
    setShowStrip(false);
    onOpenChange(true);
  };

  const pickedMedium = mediumCandidates.filter((task) => pickedIds.has(task.id)).length;
  const pickedBig = bigCandidates.filter((task) => pickedIds.has(task.id)).length;
  const overMedium = pickedMedium > mediumQuota;
  const overBig = pickedBig > bigQuota;
  const empty = mediumCandidates.length === 0 && bigCandidates.length === 0;

  const commitAndClose = () => {
    onCommit();
    onOpenChange(false);
  };

  function pickRow(task: Task) {
    const title = locale === "he" && task.title_he ? task.title_he : task.title;
    const isPicked = pickedIds.has(task.id);
    return (
      <div key={task.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" dir="auto">{title}</p>
        </div>
        <Button
          size="sm"
          variant={isPicked ? "default" : "ghost"}
          className={cn("h-8 gap-1", !isPicked && "text-muted-foreground")}
          title={isPicked ? t("remove") : t("add")}
          aria-label={isPicked ? t("remove") : t("add")}
          onClick={() => onPlanToggle(task.id, !isPicked)}
        >
          {isPicked ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{isPicked ? t("remove") : t("add")}</span>
        </Button>
      </div>
    );
  }

  function section(heading: string, count: number, quota: number, over: boolean, list: Task[]) {
    if (list.length === 0) return null;
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{heading}</p>
          <span className={cn("text-xs font-medium", over ? "text-status-late" : "text-muted-foreground")}>
            {count}/{quota}
          </span>
        </div>
        {list.map(pickRow)}
      </div>
    );
  }

  return (
    <>
      {showStrip && (
        <div className="flex w-full items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm text-foreground">
          <button
            type="button"
            onClick={openPicker}
            className="flex min-w-0 flex-1 items-center gap-2 text-start hover:opacity-80 transition-opacity"
          >
            <Sun className="h-4 w-4 shrink-0 text-primary" />
            <span dir="auto">{t("banner")}</span>
          </button>
          <button
            type="button"
            onClick={dismissStrip}
            aria-label={t("close")}
            title={t("close")}
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-start">{t("title")}</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground" dir="auto">
            {t("hint", { medium: mediumQuota, big: bigQuota })}
          </p>

          {(overMedium || overBig) && (
            <p className="flex items-center gap-1.5 text-xs text-status-late" dir="auto">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {t("over")}
            </p>
          )}

          {empty ? (
            <p className="py-6 text-center text-sm text-muted-foreground" dir="auto">{t("empty")}</p>
          ) : (
            <div className="space-y-4">
              {section(t("bigHeading"), pickedBig, bigQuota, overBig, bigCandidates)}
              {section(t("mediumHeading"), pickedMedium, mediumQuota, overMedium, mediumCandidates)}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>{t("close")}</Button>
            <Button onClick={commitAndClose}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
