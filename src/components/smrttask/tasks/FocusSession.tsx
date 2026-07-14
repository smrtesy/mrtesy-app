"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useOptionalPaneNav } from "@/lib/panes/nav";
import { Timer, X, Check, ClipboardList, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { DecisionDialog } from "./DecisionDialog";

/** A ready plan task — the "current stage" (from GET /plan/:id/focus-stage). */
interface FocusStage {
  id: string;
  title: string;
  title_he: string | null;
  is_decision?: boolean | null;
}

function fmtClock(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? "-" : "";
  const s = Math.abs(totalSeconds);
  const m = Math.floor(s / 60);
  return `${sign}${m}:${String(s % 60).padStart(2, "0")}`;
}

/** A short two-tone chime via the Web Audio API — the marathon has no sound, so
 *  this is self-contained (no asset). Best-effort: silently no-ops if the
 *  browser blocks audio (e.g. no prior user gesture). */
function playChime() {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    [880, 1174].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    /* audio unavailable — the blocking overlay still shows */
  }
}

/**
 * Daily focus session over a smrtPlan plan (docs/day-tools-plan.md §8.5).
 * A fork of MarathonMode's full-screen shell, but single-plan and counting
 * DOWN from the daily commitment: it shows the current stage (first ready
 * task), lets you tick it off (which releases its dependents via the engine),
 * and at 0:00 plays a chime + a blocking overlay (done today / +5 min /
 * completed). The run is logged to focus_sessions.
 */
export function FocusSession({
  planId,
  planTitle,
  dailyMinutes,
  locale,
  onExit,
}: {
  planId: string;
  planTitle: string;
  dailyMinutes: number;
  locale: string;
  /** Close the session screen and refresh the desk. */
  onExit: () => void;
}) {
  // Inside a tabs-workspace pane the run must stay INSIDE the pane (the
  // user keeps other tabs usable beside it); full-page keeps the old
  // fullscreen takeover. The pane body div is position:relative.
  const overlayFrame = useOptionalPaneNav() ? "absolute inset-0" : "wa-panel-pushed fixed inset-0";
  const t = useTranslations("focusSession");
  const [targetSeconds, setTargetSeconds] = useState(dailyMinutes * 60);
  const [elapsed, setElapsed] = useState(0);
  const [stage, setStage] = useState<FocusStage | null>(null);
  const [tasksCompleted, setTasksCompleted] = useState(0);
  const [blocking, setBlocking] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  // The in-flight create, so an exit BEFORE it resolves can still await the id
  // and close the row (otherwise it'd be orphaned with ended_at=null).
  const createRef = useRef<Promise<string | null> | null>(null);
  const closedRef = useRef(false);
  const firedRef = useRef(false); // the 0:00 chime/overlay fires exactly once

  // Open the session record + start the clock.
  useEffect(() => {
    createRef.current = api<{ session: { id: string } }>("/api/focus-sessions", {
      method: "POST",
      body: { plan_id: planId, planned_minutes: dailyMinutes },
    })
      .then((res) => { sessionIdRef.current = res.session.id; return res.session.id; })
      .catch(() => null); // the session still runs locally; only the log is lost
    const iv = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [planId, dailyMinutes]);

  const loadStage = useCallback(async () => {
    try {
      const { stage: s } = await api<{ stage: FocusStage | null }>(`/api/plan/${planId}/focus-stage`);
      setStage(s);
    } catch { /* keep the last stage on a transient error */ }
  }, [planId]);
  useEffect(() => { void loadStage(); }, [loadStage]);

  const remaining = targetSeconds - elapsed;

  // At 0:00 — chime once + raise the blocking overlay.
  useEffect(() => {
    if (remaining <= 0 && !firedRef.current) {
      firedRef.current = true;
      playChime();
      setBlocking(true);
    }
  }, [remaining]);

  /** Close the focus_sessions row with the outcome, then leave. */
  const finish = useCallback(async (completedFull: boolean) => {
    if (closedRef.current) { onExit(); return; }
    closedRef.current = true;
    // If the open POST hasn't resolved yet, wait for it so the row is closed
    // rather than left orphaned (ended_at=null) — but don't hang forever.
    const id = sessionIdRef.current ?? (createRef.current ? await createRef.current : null);
    if (id) {
      try {
        await api(`/api/focus-sessions/${id}`, {
          method: "PATCH",
          body: {
            actual_minutes: Math.round(elapsed / 60),
            tasks_completed: tasksCompleted,
            completed_full: completedFull,
          },
        });
      } catch { /* non-fatal — the run happened, only the log update failed */ }
    }
    onExit();
  }, [elapsed, tasksCompleted, onExit]);

  /** Tick the current stage done → the engine releases its dependents → the
   *  next ready stage surfaces on reload. A decision stage first asks for its
   *  outcome (propagated to the tasks it affects). */
  async function completeStage() {
    if (!stage || busy) return;
    if (stage.is_decision) { setDecisionOpen(true); return; }
    await doCompleteStage();
  }

  async function doCompleteStage(decision?: string) {
    if (!stage || busy) return;
    setBusy(true);
    try {
      await api(`/api/plan-tasks/${stage.id}/done`, {
        method: "PATCH",
        body: { done: true, ...(decision ? { decision } : {}) },
      });
      setTasksCompleted((n) => n + 1);
      await loadStage();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  const extend = () => {
    // "+5 minutes": push the target out and let the clock keep running. The
    // extension re-arms the 0:00 trigger so the chime fires again at the new end.
    setTargetSeconds((s) => s + 5 * 60);
    firedRef.current = false;
    setBlocking(false);
  };

  const stageTitle = stage ? (locale === "he" && stage.title_he ? stage.title_he : stage.title) : null;
  const overtime = remaining < 0;

  return (
    <div className={`${overlayFrame} z-50 flex flex-col bg-background`} dir={locale === "he" ? "rtl" : "ltr"}>
      {/* Header: count-down + plan + stages ticked + exit */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <span
          className={cn("flex items-center gap-1.5 font-mono text-lg font-bold tabular-nums", overtime && "text-status-warn")}
          dir="ltr"
        >
          <Timer className="h-5 w-5" /> {fmtClock(remaining)}
        </span>
        <span className="truncate rounded-full bg-secondary px-2.5 py-0.5 text-sm font-medium text-muted-foreground" dir="auto">
          {planTitle}
        </span>
        <span className="text-xs text-muted-foreground">{t("stagesDone", { count: tasksCompleted })}</span>
        <Button variant="ghost" size="icon" className="ms-auto" onClick={() => void finish(false)} aria-label={t("exit")}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      {/* The current stage */}
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-8 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <ClipboardList className="h-6 w-6 text-primary" />
        </span>
        {stageTitle ? (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("currentStage")}</p>
            <h2 className="max-w-xl text-2xl font-bold leading-snug" dir="auto">{stageTitle}</h2>
            <Button
              size="lg"
              className="h-14 min-w-40 gap-2 bg-status-ok text-white hover:bg-status-ok/90 text-lg"
              onClick={completeStage}
              disabled={busy}
            >
              <Check className="h-5 w-5" /> {t("stageDone")}
            </Button>
          </>
        ) : (
          <p className="max-w-md text-lg text-muted-foreground" dir="auto">{t("noStage")}</p>
        )}
      </div>

      {/* 0:00 — blocking overlay + the three choices */}
      {blocking && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-background/95 px-6 text-center backdrop-blur">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-status-ok-bg">
            <CheckCircle2 className="h-8 w-8 text-status-ok" />
          </span>
          <h2 className="text-2xl font-bold" dir="auto">{t("timeUpTitle", { minutes: dailyMinutes })}</h2>
          <div className="flex flex-col items-stretch gap-2.5 sm:flex-row">
            <Button size="lg" className="min-w-40" onClick={() => void finish(false)}>{t("doneToday")}</Button>
            <Button size="lg" variant="outline" className="min-w-40" onClick={extend}>{t("fiveMore")}</Button>
            <Button size="lg" variant="ghost" className="min-w-40 text-status-ok" onClick={() => void finish(true)}>
              {t("completed")}
            </Button>
          </div>
        </div>
      )}

      <DecisionDialog
        open={decisionOpen}
        taskTitle={stageTitle ?? ""}
        onClose={() => setDecisionOpen(false)}
        onConfirm={(decision) => { setDecisionOpen(false); void doCompleteStage(decision); }}
      />
    </div>
  );
}
