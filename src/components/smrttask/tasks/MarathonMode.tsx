"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Zap, X, SkipForward, Scale, Trophy, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ManualTaskInput } from "./ManualTaskInput";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Task } from "@/types/task";

interface MarathonStats {
  total_runs: number;
  total_completed: number;
  best_count: number;
  best_pace_seconds: number | null;
  week_runs: number;
  week_completed: number;
}

function fmtClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Quick-task marathon: full-screen, one quick task at a time, a running timer,
 * and a finish screen that turns the session into a small game — total, pace,
 * personal records, confetti on a new best.
 */
export function MarathonMode({
  tasks,
  locale,
  mode = "quick",
  onComplete,
  onReclassify,
  onExit,
}: {
  /** The desk tasks of this run's column, in display order. */
  tasks: Task[];
  locale: string;
  /** Which column is being run — flips the reclassify button's direction. */
  mode?: "quick" | "regular";
  /** Completes the task (caller hits the API + refreshes its lists). */
  onComplete: (taskId: string) => Promise<void>;
  /** "Wrong column" — flips the task's size and drops it from the run. */
  onReclassify: (taskId: string) => Promise<void>;
  onExit: () => void;
}) {
  const t = useTranslations("marathon");
  // Snapshot the queue at start: list refetches during the run must not
  // reshuffle what the runner sees.
  const [queue] = useState<Task[]>(() => tasks);
  const [index, setIndex] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [skipCount, setSkipCount] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [finish, setFinish] = useState<{ stats: MarathonStats; prev: MarathonStats; seconds: number } | null>(null);
  const runIdRef = useRef<string | null>(null);
  const closedRef = useRef(false);

  // Open the run + start the clock.
  useEffect(() => {
    api<{ run: { id: string } }>("/api/marathon-runs", { method: "POST" })
      .then((res) => { runIdRef.current = res.run.id; })
      .catch(() => { /* the run still works locally; only records are lost */ });
    const iv = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const current = queue[index] ?? null;
  const remaining = queue.length - index;

  async function closeRun(done: number, skipped: number): Promise<{ stats: MarathonStats; prev: MarathonStats } | null> {
    if (closedRef.current) return null;
    closedRef.current = true;
    if (!runIdRef.current) return null;
    try {
      const res = await api<{ stats: MarathonStats; prev_stats: MarathonStats }>(
        `/api/marathon-runs/${runIdRef.current}`,
        { method: "PATCH", body: { completed_count: done, skipped_count: skipped } },
      );
      return { stats: res.stats, prev: res.prev_stats };
    } catch {
      return null;
    }
  }

  async function finishRun(done: number, skipped: number) {
    const result = await closeRun(done, skipped);
    if (result && done > 0) {
      setFinish({ stats: result.stats, prev: result.prev, seconds });
    } else {
      onExit();
    }
  }

  async function handleDone() {
    if (!current || busy) return;
    setBusy(true);
    try {
      await onComplete(current.id);
      const nextDone = doneCount + 1;
      setDoneCount(nextDone);
      if (index + 1 >= queue.length) await finishRun(nextDone, skipCount);
      else setIndex(index + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (!current || busy) return;
    const nextSkip = skipCount + 1;
    setSkipCount(nextSkip);
    if (index + 1 >= queue.length) await finishRun(doneCount, nextSkip);
    else setIndex(index + 1);
  }

  async function handleReclassify() {
    if (!current || busy) return;
    setBusy(true);
    try {
      await onReclassify(current.id);
      const nextSkip = skipCount + 1;
      setSkipCount(nextSkip);
      if (index + 1 >= queue.length) await finishRun(doneCount, nextSkip);
      else setIndex(index + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleExit() {
    await finishRun(doneCount, skipCount);
  }

  const title = current
    ? (locale === "he" && current.title_he ? current.title_he : current.title)
    : "";

  if (finish) {
    return (
      <FinishScreen
        seconds={finish.seconds}
        done={doneCount}
        stats={finish.stats}
        prev={finish.prev}
        onExit={onExit}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background" dir={locale === "he" ? "rtl" : "ltr"}>
      {/* Header: timer + progress + new-item + exit */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex items-center gap-1.5 font-mono text-lg font-bold tabular-nums" dir="ltr">
          {fmtClock(seconds)}
        </span>
        <span className="rounded-full bg-secondary px-2.5 py-0.5 text-sm font-medium text-muted-foreground">
          {t("progress", { done: doneCount, total: queue.length })}
        </span>
        <span className="text-xs text-muted-foreground">{t("remaining", { count: remaining })}</span>
        {/* Things pop into your head mid-run — capture them without leaving.
            The timer keeps running. */}
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto"
          onClick={() => setNewItemOpen(true)}
          aria-label={t("newItem")}
          title={t("newItem")}
        >
          <Plus className="h-5 w-5" />
        </Button>
        <Button variant="ghost" size="icon" onClick={handleExit} aria-label={t("exit")}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* New task/info capture — rendered above the full-screen run. */}
      <ManualTaskInput
        open={newItemOpen}
        onClose={() => setNewItemOpen(false)}
        onCreated={() => setNewItemOpen(false)}
      />

      {/* The one task */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-warn-bg">
          <Zap className="h-6 w-6 text-status-warn" />
        </span>
        <h2 className="max-w-xl text-2xl font-bold leading-snug" dir="auto">{title}</h2>
        {current?.description && (
          <p className="max-w-lg text-sm text-muted-foreground line-clamp-3" dir="auto">{current.description}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-center gap-3 border-t px-4 py-5">
        <Button
          size="lg"
          className="h-14 min-w-36 gap-2 bg-status-ok text-white hover:bg-status-ok/90 text-lg"
          onClick={handleDone}
          disabled={busy || !current}
        >
          ✓ {t("done")}
        </Button>
        <Button size="lg" variant="outline" className="h-14 gap-2" onClick={handleSkip} disabled={busy || !current}>
          <SkipForward className="h-4 w-4" />
          {t("skip")}
        </Button>
        <Button size="lg" variant="ghost" className="h-14 gap-2 text-muted-foreground" onClick={handleReclassify} disabled={busy || !current}>
          <Scale className="h-4 w-4" />
          {mode === "quick" ? t("notQuick") : t("isQuick")}
        </Button>
      </div>
    </div>
  );
}

function FinishScreen({
  seconds, done, stats, prev, onExit,
}: {
  seconds: number;
  done: number;
  stats: MarathonStats;
  prev: MarathonStats;
  onExit: () => void;
}) {
  const t = useTranslations("marathon");
  const newRecord = done > prev.best_count && prev.best_count > 0;
  const firstRun = prev.total_runs === 0;
  const pace = done > 0 ? Math.round(seconds / done) : 0;

  // Lightweight confetti: a burst of emoji pieces with randomized fall paths.
  const confetti = useMemo(() => {
    if (!newRecord) return [];
    return Array.from({ length: 28 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.8,
      duration: 1.8 + Math.random() * 1.6,
      char: ["🎉", "⚡", "✨", "🏆"][i % 4],
    }));
  }, [newRecord]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background px-6 text-center overflow-hidden">
      {confetti.map((c) => (
        <span
          key={c.id}
          className="pointer-events-none absolute top-0 animate-confetti-fall text-2xl"
          style={{
            insetInlineStart: `${c.left}%`,
            animationDelay: `${c.delay}s`,
            animationDuration: `${c.duration}s`,
          }}
        >
          {c.char}
        </span>
      ))}

      <Trophy className={cn("h-12 w-12", newRecord ? "text-status-warn" : "text-muted-foreground/40")} />
      <h2 className="text-2xl font-bold">
        {t("finishTitle", { count: done, time: fmtClock(seconds) })}
      </h2>
      {newRecord && <p className="text-lg font-semibold text-status-warn">{t("newRecord", { prev: prev.best_count })}</p>}
      {!newRecord && !firstRun && stats.best_count > 0 && (
        <p className="text-sm text-muted-foreground">{t("bestSoFar", { count: stats.best_count })}</p>
      )}
      {pace > 0 && (
        <p className="text-sm text-muted-foreground">{t("pace", { time: fmtClock(pace) })}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {t("weekSummary", { runs: stats.week_runs, completed: stats.week_completed })}
      </p>
      <Button size="lg" className="mt-2 min-w-40" onClick={onExit}>
        {t("backToDesk")}
      </Button>
    </div>
  );
}
