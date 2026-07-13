"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Zap, X, SkipForward, Scale, Trophy, Plus, MapPin, ClipboardList, ExternalLink, AlertTriangle, Home, Clock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ManualTaskInput } from "./ManualTaskInput";
import { TaskChecklist } from "./TaskChecklist";
import { ContextButton } from "./ContextPanel";
import { AssigneeButton } from "./AssigneeButton";
import { DueDateChip } from "./DueDateChip";
import { SnoozeDialog } from "./SnoozeDialog";
import { SaveAsInfoButton } from "@/components/smrttask/common/SaveAsInfoButton";
import { useWorkCalendar } from "@/hooks/useWorkCalendar";
import { effectiveDeadline } from "@/lib/workdays";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useWhatsAppPanel } from "@/contexts/WhatsAppPanelContext";
import { LinkActions } from "@/components/smrttask/common/LinkActions";
import { taskActionNuggets } from "@/lib/smrttask/links";
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
  const tTasks = useTranslations("tasks");
  const tDetail = useTranslations("taskDetailExt");
  const waPanel = useWhatsAppPanel();
  const blocked = useWorkCalendar();
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

  // Per-task clock — resets on every task. Drives a light over-time nudge:
  // a quick task is meant to take ~7 minutes, a regular one ~30. We never
  // block or auto-advance; just flag visually that the estimate was passed.
  const [taskSeconds, setTaskSeconds] = useState(0);
  useEffect(() => {
    setTaskSeconds(0);
    const iv = setInterval(() => setTaskSeconds((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [index]);
  const limitMin = (current?.size ?? mode) === "quick" ? 7 : 30;
  const overtime = !!current && taskSeconds >= limitMin * 60;

  // Pull the full content of the task in focus — description, subtasks
  // (checklist), attached materials/files and source — so the runner has
  // everything needed to finish it without leaving the run.
  const [detail, setDetail] = useState<Task | null>(null);
  const currentId = current?.id ?? null;
  const loadDetail = useCallback(async () => {
    if (!currentId) { setDetail(null); return; }
    try {
      const { task } = await api<{ task: Task }>(`/api/tasks/${currentId}`);
      setDetail(task);
    } catch { /* fall back to the list row's fields */ }
  }, [currentId]);
  useEffect(() => { setDetail(null); void loadDetail(); }, [loadDetail]);

  // The same task-window actions (size/home/snooze/assign/due/info/delete) are
  // offered in-run. Edits PATCH the shared task row and refresh the detail; the
  // ones that drop the task off the desk (snooze/delete) advance the run.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  async function patchCurrent(body: Record<string, unknown>) {
    if (!currentId) return;
    try {
      await api(`/api/tasks/${currentId}`, { method: "PATCH", body });
      await loadDetail();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  // Snooze / delete remove the task from the desk → advance like a skip.
  async function advancePastCurrent() {
    const nextSkip = skipCount + 1;
    setSkipCount(nextSkip);
    if (index + 1 >= queue.length) await finishRun(doneCount, nextSkip);
    else setIndex(index + 1);
  }
  async function handleSnoozeConfirm(untilIso: string) {
    if (!currentId) return;
    try {
      await api(`/api/tasks/${currentId}/snooze`, { method: "POST", body: { until: untilIso } });
      setSnoozeOpen(false);
      await advancePastCurrent();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function handleDeleteCurrent() {
    if (!currentId || !window.confirm(tTasks("deleteConfirm"))) return;
    try {
      await api(`/api/tasks/${currentId}`, { method: "DELETE" });
      await advancePastCurrent();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

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

  // Material to show in-run. Prefer the freshly fetched detail; fall back to the
  // list row so something shows before the fetch lands.
  const view = detail ?? current;
  const isQuickNow = (view?.size ?? mode) === "quick";
  const isHomeNow = view?.context === "home";
  const isOutsideNow = view?.context === "outside";
  const description = detail?.description ?? current?.description ?? null;
  const checklist = detail?.checklist ?? [];
  const materials = detail?.task_materials ?? [];
  const driveDocs = (detail?.linked_drive_docs ?? []).filter((d) => !!d.url);
  const sourceUrl = detail?.source_messages?.source_url ?? current?.source_messages?.source_url ?? null;
  // WhatsApp sources open in the in-app docked panel (consistent with the task
  // lists / log) instead of launching the external WhatsApp client.
  const isWaSource = sourceUrl ? /wa\.me\//.test(sourceUrl) : false;
  const sourceWaPhone = isWaSource
    ? ((sourceUrl ?? "").match(/wa\.me\/([^?#]+)/)?.[1] ?? "").replace(/\D/g, "")
    : "";
  // Plan tasks carry their plan/stage on the desk row — the "where this lives".
  const planLabel = current?.plan_id
    ? [
        locale === "en" ? current.plan_title_en || current.plan_title_he : current.plan_title_he || current.plan_title_en,
        locale === "en" ? current.stage_name_en || current.stage_name_he : current.stage_name_he || current.stage_name_en,
      ].filter(Boolean).join(" / ")
    : "";
  const hasAttachments = !!sourceUrl || driveDocs.length > 0 || materials.length > 0;
  // Action nuggets — one-click deep links (payment/tracking/etc.) so the runner
  // acts without opening the source. Attachments render in their own block
  // below, so exclude them here to avoid a double row.
  const actionLinks = view ? taskActionNuggets(view) : [];
  const chipCls =
    "inline-flex max-w-[220px] items-center gap-1 truncate rounded-full border bg-secondary/60 px-2 py-0.5 text-[12px] hover:bg-accent";

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
    <div className="wa-panel-pushed fixed inset-0 z-50 flex flex-col bg-background" dir={locale === "he" ? "rtl" : "ltr"}>
      {/* Header: run timer + per-task timer + progress + new-item + exit */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span className="flex items-center gap-1.5 font-mono text-lg font-bold tabular-nums" dir="ltr">
          {fmtClock(seconds)}
        </span>
        {/* per-task clock — turns amber once the size's time estimate is passed */}
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-mono text-xs font-medium tabular-nums",
            overtime ? "bg-status-warn-bg text-status-warn" : "bg-secondary text-muted-foreground",
          )}
          dir="ltr"
        >
          {fmtClock(taskSeconds)}
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

      {/* Light over-time nudge — never blocks, just a calm banner. */}
      {overtime && (
        <div className="flex items-center justify-center gap-1.5 bg-status-warn-bg px-4 py-1.5 text-[12.5px] font-medium text-status-warn">
          <AlertTriangle className="h-3.5 w-3.5" /> {t("overtime", { min: limitMin })}
        </div>
      )}

      {/* New task/info capture — rendered above the full-screen run. */}
      <ManualTaskInput
        open={newItemOpen}
        onClose={() => setNewItemOpen(false)}
        onCreated={() => setNewItemOpen(false)}
      />

      {/* The one task — full content so it can be finished without leaving */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl space-y-5 px-6 py-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-warn-bg">
              <Zap className="h-6 w-6 text-status-warn" />
            </span>
            <h2 className="max-w-xl text-2xl font-bold leading-snug" dir="auto">{title}</h2>
            {planLabel && (
              <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-[12px] font-medium text-muted-foreground">
                <ClipboardList className="h-3.5 w-3.5" /> {planLabel}
              </span>
            )}
          </div>

          {/* Same action icons as the regular task window — available in-run so
              nothing forces the runner to leave the flow to act on a task. */}
          {current && view && (
            <div className="flex flex-wrap items-center justify-center gap-1 rounded-lg border bg-card/50 px-2 py-1.5">
              <ContextButton task={view} locale={locale} className="h-9 w-9 [&_svg]:size-4" />
              <IconButton
                label={isQuickNow ? tTasks("row.sizeQuickHint") : tTasks("row.sizeRegularHint")}
                color="amber"
                className={isQuickNow ? "text-status-warn" : undefined}
                onClick={() => patchCurrent({ size: isQuickNow ? "medium" : "quick" })}
              >
                <Zap className={isQuickNow ? "fill-current" : undefined} />
              </IconButton>
              <IconButton
                label={tDetail("contextHome")}
                color="primary"
                aria-pressed={isHomeNow}
                className={isHomeNow ? "text-primary" : undefined}
                onClick={() => patchCurrent({ context: isHomeNow ? null : "home" })}
              >
                <Home className={isHomeNow ? "fill-current" : undefined} />
              </IconButton>
              <IconButton
                label={tDetail("contextOutside")}
                color="primary"
                aria-pressed={isOutsideNow}
                className={isOutsideNow ? "text-primary" : undefined}
                onClick={() => patchCurrent({ context: isOutsideNow ? null : "outside" })}
              >
                <MapPin className={isOutsideNow ? "fill-current" : undefined} />
              </IconButton>
              <IconButton label={tTasks("actions.snooze")} color="amber" onClick={() => setSnoozeOpen(true)}>
                <Clock />
              </IconButton>
              <SaveAsInfoButton defaultProjectId={view.project_id} defaultTitle={title} defaultBody={view.description} />
              <AssigneeButton
                assignedTo={view.assigned_to_user_id ?? null}
                onAssign={(uid) => patchCurrent({ assigned_to_user_id: uid })}
              />
              <DueDateChip
                deadline={effectiveDeadline(view)}
                time={view.due_date ? view.due_time : null}
                blocked={blocked}
                locked={!!view.plan_id}
                onChange={view.plan_id ? undefined : (d, tm) => {
                  // Time makes it an event; clearing the time reverts to a task.
                  const body: Record<string, unknown> = { due_date: d, due_time: tm };
                  if (d && tm) body.task_type = "meeting";
                  else if (view.task_type === "meeting") body.task_type = "action";
                  patchCurrent(body);
                }}
              />
              <IconButton label={tTasks("actions.delete")} color="red" onClick={handleDeleteCurrent}>
                <Trash2 />
              </IconButton>
            </div>
          )}

          {description && (
            <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80" dir="auto">{description}</p>
          )}

          {/* action nuggets: one-click deep links, right under the description (no heading) */}
          {actionLinks.length > 0 && <LinkActions links={actionLinks} />}

          {/* attachments: origin deep-link + Drive docs + task materials */}
          {hasAttachments && (
            <div className="space-y-1.5">
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{t("attachments")}</h3>
              <div className="flex flex-wrap gap-1.5">
                {sourceUrl && (
                  isWaSource ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (sourceWaPhone) waPanel.openChat(sourceWaPhone);
                        else waPanel.open();
                      }}
                      className={chipCls}
                    >
                      <ExternalLink className="h-3 w-3 flex-shrink-0" /> <span className="truncate">{t("source")}</span>
                    </button>
                  ) : (
                    <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className={chipCls}>
                      <ExternalLink className="h-3 w-3 flex-shrink-0" /> <span className="truncate">{t("source")}</span>
                    </a>
                  )
                )}
                {driveDocs.map((d, i) => (
                  <a key={`d${i}`} href={d.url} target="_blank" rel="noopener noreferrer" className={chipCls}>
                    <ExternalLink className="h-3 w-3 flex-shrink-0" /> <span className="truncate">{d.name || "Drive"}</span>
                  </a>
                ))}
                {materials.filter((m) => m.url).map((m) => (
                  <a key={m.id} href={m.url} target="_blank" rel="noopener noreferrer" className={chipCls}>
                    <ExternalLink className="h-3 w-3 flex-shrink-0" /> <span className="truncate">{m.title || m.url}</span>
                  </a>
                ))}
              </div>
              {/* note-type materials (no URL) shown as plain text lines */}
              {materials.filter((m) => !m.url && m.title).map((m) => (
                <p key={m.id} className="whitespace-pre-wrap rounded-md bg-secondary/40 px-2 py-1 text-[12px] text-foreground/80" dir="auto">
                  {m.title}
                </p>
              ))}
            </div>
          )}

          {/* subtasks (checklist) — editable so items can be ticked off here */}
          {current && (
            <div className="rounded-lg border bg-card/50 p-2.5">
              <TaskChecklist taskId={current.id} items={checklist} onChange={loadDetail} />
            </div>
          )}
        </div>
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

      <SnoozeDialog open={snoozeOpen} onClose={() => setSnoozeOpen(false)} onConfirm={handleSnoozeConfirm} />
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
    <div className="wa-panel-pushed fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background px-6 text-center overflow-hidden">
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
