"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Clock, Play, Pause, Square, Sun, X, Inbox, ListChecks, AlertTriangle, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { beep } from "@/lib/sound";
import {
  useWorkClock, workedSeconds, activeSeconds, escalationOf, isRitual,
  RITUAL_ORDER, type WorkClockPhase, type Escalation,
} from "@/hooks/useWorkClock";

/**
 * The workclock bar — a thin strip at the top of the workspace, shown only
 * while the tool is on and a session is active/offered.
 *
 * Phase 1: offer + running clock + pause/stop.
 * Phase 2: guided morning ritual with per-step timers + navigation.
 * Phase 3: run mode — the active task's clock in the bar + three escalation
 * levels (soft red / popup banner / blocking screen) + the pause nag (visual +
 * sound). Phase 4 adds the end-of-day close.
 */
export function WorkClockBar() {
  const t = useTranslations("workclock");
  const locale = useLocale();
  const dir = locale === "he" ? "rtl" : "ltr";
  const router = useRouter();
  const {
    enabled, config, state, showOffer,
    start, advance, pause, resume, stop, dismissOffer, clearActiveTask, bumpAlert,
  } = useWorkClock();

  const [, setTick] = useState(0);
  // Live refs so the 1s interval always reads current state/config/callbacks
  // (the interval is created once per active-session, not per state change).
  const stateRef = useRef(state); stateRef.current = state;
  const advanceRef = useRef(advance); advanceRef.current = advance;
  const configRef = useRef(config); configRef.current = config;
  const bumpRef = useRef(bumpAlert); bumpRef.current = bumpAlert;
  // null until the first tick seeds it — so a reload with an already-tripped
  // level doesn't re-count it as a fresh rising edge (which would inflate the
  // persisted alert stats on every reload).
  const prevEscRef = useRef<Escalation | null>(null);

  const active = isRitual(state.phase) || state.phase === "running" || state.phase === "paused";
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => {
      setTick((n) => n + 1);
      const s = stateRef.current;
      const now = Date.now();
      if (s.stepEndsAt != null && now >= s.stepEndsAt) advanceRef.current();
      // Count each escalation on its rising edge (persisted via heartbeat).
      const esc = escalationOf(s, configRef.current, now);
      const prev = prevEscRef.current;
      if (prev) {
        if (esc.soft && !prev.soft) bumpRef.current("soft");
        if (esc.popup && !prev.popup) bumpRef.current("popup");
        if (esc.block && !prev.block) bumpRef.current("block");
      }
      prevEscRef.current = esc;
    }, 1000);
    return () => clearInterval(iv);
  }, [active]);

  // Navigate to each ritual step's screen when the destination changes.
  const lastDestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isRitual(state.phase)) { lastDestRef.current = null; return; }
    const dest = state.phase === "ritual_inbox" ? `/${locale}/inbox` : `/${locale}/tasks`;
    if (lastDestRef.current === dest) return;
    lastDestRef.current = dest;
    router.push(dest);
  }, [state.phase, locale, router]);

  // Pause nag: a periodic beep while paused so a forgotten pause is noticed.
  useEffect(() => {
    if (state.phase !== "paused") return;
    const nagSec = typeof config.pause_nag_sec === "number" && config.pause_nag_sec > 0 ? config.pause_nag_sec : 300;
    const iv = setInterval(() => { if (config.sound_enabled !== false) beep(2); }, nagSec * 1000);
    return () => clearInterval(iv);
  }, [state.phase, config.pause_nag_sec, config.sound_enabled]);

  // Popup/blocking dismissal (session-scoped).
  const [popupAcked, setPopupAcked] = useState(false);
  const [blockSnoozeUntil, setBlockSnoozeUntil] = useState(0);

  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!enabled || !mounted) return null;

  if (showOffer) {
    return (
      <div dir={dir} className="flex items-center gap-3 border-b border-primary/25 bg-primary/5 px-4 py-2 text-sm">
        <Sun className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate" dir="auto">{t("offerTitle")}</span>
        <Button size="sm" className="h-8 gap-1.5" onClick={start}>
          <Play className="h-3.5 w-3.5" />{t("offerStart")}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={dismissOffer}>
          {t("offerLater")}
        </Button>
      </div>
    );
  }

  if (!active) return null;

  const now = Date.now();
  const paused = state.phase === "paused";
  const ritual = isRitual(state.phase);
  const esc = ritual ? { soft: false, popup: false, block: false } : escalationOf(state, config, now);
  const hasActiveTask = state.activeTaskId != null;

  return (
    <>
      <div
        dir={dir}
        className={cn(
          "flex items-center gap-3 border-b px-4 py-1.5 text-sm transition-colors",
          esc.soft ? "bg-status-late-bg" : paused ? "bg-muted/40" : "bg-card",
        )}
      >
        {/* Day clock */}
        <div className="flex items-center gap-2">
          <span className={cn(
            "grid h-6 w-6 place-items-center rounded-md",
            esc.soft ? "bg-status-late/15 text-status-late" : paused ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
          )}>
            <Clock className="h-3.5 w-3.5" />
          </span>
          <span className="font-mono text-[15px] font-semibold tabular-nums" dir="ltr">{fmtHMS(workedSeconds(state, now))}</span>
          <span className="text-[10px] font-medium text-muted-foreground/70">{t("dayClock")}</span>
        </div>

        {ritual ? (
          <RitualMiddle phase={state.phase} stepEndsAt={state.stepEndsAt} onNext={advance} t={t} />
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="h-4 w-px bg-border" />
            {hasActiveTask ? (
              <>
                <span className="min-w-0 truncate text-[13px] font-medium" dir="auto">{state.activeTaskTitle || t("activeTask")}</span>
                {state.activeTaskSize && (
                  <span className="shrink-0 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {t(`size_${state.activeTaskSize}`)}
                  </span>
                )}
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 font-mono text-xs font-bold tabular-nums",
                    esc.soft ? "bg-status-late/15 text-status-late" : "bg-secondary text-muted-foreground",
                  )}
                  dir="ltr"
                >
                  {fmtMS(activeSeconds(state, now))}
                </span>
                {esc.soft && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold text-status-late">
                    <AlertTriangle className="h-3 w-3" />{t("overQuick")}
                  </span>
                )}
              </>
            ) : (
              <span className="truncate text-xs text-muted-foreground" dir="auto">{t("openTaskHint")}</span>
            )}
          </div>
        )}

        {!ritual && (
          <div className="ms-auto flex items-center gap-1.5">
            {paused ? (
              <span className="inline-flex animate-pulse items-center gap-1 rounded-full bg-status-warn-bg px-2 py-0.5 text-[11px] font-bold text-status-warn">
                <Volume2 className="h-3 w-3" />{t("resumeNag")}
              </span>
            ) : null}
            {paused ? (
              <Button size="sm" className="h-8 gap-1.5" onClick={resume}>
                <Play className="h-3.5 w-3.5" />{t("resume")}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-muted-foreground" onClick={pause} aria-label={t("pause")} title={t("pause")}>
                <Pause className="h-4 w-4" />
              </Button>
            )}
            <Button
              size="sm" variant="ghost"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-status-late"
              onClick={() => stop("manual")} aria-label={t("stop")} title={t("stop")}
            >
              {paused ? <X className="h-4 w-4" /> : <Square className="h-4 w-4" />}
            </Button>
          </div>
        )}
      </div>

      {/* Popup banner — quick total over the limit */}
      {esc.popup && !popupAcked && (
        <div dir={dir} className="flex items-start gap-3 border-b border-status-warn/40 bg-status-warn-bg px-4 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground" dir="auto">{t("popupQuickTitle")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground" dir="auto">{t("popupQuickHint")}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="h-8" onClick={() => setPopupAcked(true)}>{t("popupContinue")}</Button>
              <Button
                size="sm" variant="outline" className="h-8"
                onClick={() => { clearActiveTask(); setPopupAcked(true); router.push(`/${locale}/tasks`); }}
              >
                {t("popupToMedium")}
              </Button>
            </div>
          </div>
          <button type="button" onClick={() => setPopupAcked(true)} aria-label={t("close")} className="rounded p-1 text-muted-foreground hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Blocking screen — a medium/big task over its hard limit */}
      {esc.block && now >= blockSnoozeUntil && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-background/80 p-6 backdrop-blur-sm" dir={dir}>
          <div className="w-full max-w-sm rounded-2xl border border-t-4 border-t-status-late bg-card p-6 text-center shadow-xl">
            <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-status-late/15 text-status-late">
              <AlertTriangle className="h-6 w-6" />
            </span>
            <h3 className="text-base font-bold" dir="auto">
              {state.activeTaskSize === "big" ? t("blockBigTitle") : t("blockMediumTitle")}
            </h3>
            <p className="mt-1 text-[13px] text-muted-foreground" dir="auto">{t("blockHint")}</p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => { clearActiveTask(); }}>{t("blockStopped")}</Button>
              <Button size="sm" variant="outline" onClick={() => setBlockSnoozeUntil(Date.now() + 15 * 60 * 1000)}>
                {t("blockMore")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function RitualMiddle({
  phase, stepEndsAt, onNext, t,
}: {
  phase: WorkClockPhase; stepEndsAt: number | null; onNext: () => void; t: ReturnType<typeof useTranslations>;
}) {
  const stepNum = RITUAL_ORDER.indexOf(phase) + 1;
  const label = phase === "ritual_inbox" ? t("stepInbox") : phase === "ritual_plan" ? t("stepPlan") : t("stepRun");
  const Icon = phase === "ritual_inbox" ? Inbox : phase === "ritual_plan" ? ListChecks : Play;
  const remaining = stepEndsAt != null ? Math.max(0, Math.ceil((stepEndsAt - Date.now()) / 1000)) : 0;
  const last = phase === "ritual_run";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
        <Icon className="h-3 w-3" />{t("stepBadge", { n: stepNum })}
      </span>
      <span className="min-w-0 truncate text-[13px] font-medium" dir="auto">{label}</span>
      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-mono text-xs font-bold tabular-nums" dir="ltr">{fmtMS(remaining)}</span>
      <Button size="sm" className="ms-auto h-8 shrink-0 gap-1.5" onClick={onNext}>
        <Play className="h-3.5 w-3.5" />{last ? t("enterRun") : t("stepNext")}
      </Button>
    </div>
  );
}

function fmtHMS(total: number): string {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
function fmtMS(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
