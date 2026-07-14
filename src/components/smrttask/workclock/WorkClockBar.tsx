"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Clock, Play, Pause, Square, Sun, X, Inbox, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkClock, workedSeconds, isRitual, RITUAL_ORDER, type WorkClockPhase } from "@/hooks/useWorkClock";

/**
 * The workclock bar — a thin strip at the top of the workspace, shown only
 * while the tool is on and a clock session is active/offered (quiet by default,
 * per the compact-UI rule).
 *
 * Phase 1: the once-a-day offer + a running clock with pause/resume/stop.
 * Phase 2: the guided morning ritual — inbox → plan → run — with per-step
 * countdown timers and navigation to each step. Run mode + escalations (phase 3)
 * and the end-of-day close (phase 4) extend this.
 */
export function WorkClockBar() {
  const t = useTranslations("workclock");
  const locale = useLocale();
  const dir = locale === "he" ? "rtl" : "ltr";
  const router = useRouter();
  const { enabled, state, showOffer, start, advance, pause, resume, stop, dismissOffer } = useWorkClock();

  // Local 1s tick so the running clock + ritual countdown update on screen (the
  // store is time-anchored, not a counter — see useWorkClock).
  const [, setTick] = useState(0);
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const active = isRitual(state.phase) || state.phase === "running";
  useEffect(() => {
    if (!active) return;
    const iv = setInterval(() => {
      setTick((n) => n + 1);
      // Auto-advance a ritual step once its timer elapses.
      if (state.stepEndsAt != null && Date.now() >= state.stepEndsAt) advanceRef.current();
    }, 1000);
    return () => clearInterval(iv);
  }, [active, state.stepEndsAt]);

  // Navigate to each ritual step's screen when the destination changes. Tracks
  // the last destination (not the phase) so plan→run — which share /tasks —
  // doesn't re-push the same URL.
  const lastDestRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isRitual(state.phase)) { lastDestRef.current = null; return; }
    const dest = state.phase === "ritual_inbox" ? `/${locale}/inbox` : `/${locale}/tasks`;
    if (lastDestRef.current === dest) return;
    lastDestRef.current = dest;
    router.push(dest);
  }, [state.phase, locale, router]);

  // Render nothing until mounted: the clock state is hydrated from localStorage
  // on the client, so a server-rendered null must match the first client render.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!enabled || !mounted) return null;

  // ── the once-a-day offer ──────────────────────────────────────────────────
  if (showOffer) {
    return (
      <div dir={dir} className="flex items-center gap-3 border-b border-primary/25 bg-primary/5 px-4 py-2 text-sm">
        <Sun className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate" dir="auto">{t("offerTitle")}</span>
        <Button size="sm" className="h-8 gap-1.5" onClick={start}>
          <Play className="h-3.5 w-3.5" />
          {t("offerStart")}
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={dismissOffer}>
          {t("offerLater")}
        </Button>
      </div>
    );
  }

  if (!isRitual(state.phase) && state.phase !== "running" && state.phase !== "paused") return null;

  const secs = workedSeconds(state, Date.now());
  const paused = state.phase === "paused";
  const ritual = isRitual(state.phase);

  // ── the running/ritual bar ──────────────────────────────────────────────
  return (
    <div
      dir={dir}
      className={cn(
        "flex items-center gap-3 border-b px-4 py-1.5 text-sm transition-colors",
        paused ? "bg-muted/40" : "bg-card",
      )}
    >
      {/* Day clock — always shown */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid h-6 w-6 place-items-center rounded-md",
            paused ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
          )}
        >
          <Clock className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-[15px] font-semibold tabular-nums" dir="ltr">{fmtHMS(secs)}</span>
        <span className="text-[10px] font-medium text-muted-foreground/70">{t("dayClock")}</span>
      </div>

      {ritual ? (
        <RitualMiddle phase={state.phase} stepEndsAt={state.stepEndsAt} onNext={advance} t={t} />
      ) : paused ? (
        <span className="text-xs font-medium text-status-warn" dir="auto">{t("pausedLabel")}</span>
      ) : null}

      <div className="ms-auto flex items-center gap-1.5">
        {ritual ? null : paused ? (
          <Button size="sm" className="h-8 gap-1.5" onClick={resume}>
            <Play className="h-3.5 w-3.5" />
            {t("resume")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 text-muted-foreground"
            onClick={pause}
            aria-label={t("pause")}
            title={t("pause")}
          >
            <Pause className="h-4 w-4" />
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 text-muted-foreground hover:text-status-late"
          onClick={() => stop("manual")}
          aria-label={t("stop")}
          title={t("stop")}
        >
          {paused ? <X className="h-4 w-4" /> : <Square className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}

/** The middle section during the morning ritual: step chip + label + countdown
 *  + a "next" button. */
function RitualMiddle({
  phase, stepEndsAt, onNext, t,
}: {
  phase: WorkClockPhase;
  stepEndsAt: number | null;
  onNext: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const stepNum = RITUAL_ORDER.indexOf(phase) + 1;
  const label = phase === "ritual_inbox" ? t("stepInbox") : phase === "ritual_plan" ? t("stepPlan") : t("stepRun");
  const Icon = phase === "ritual_inbox" ? Inbox : phase === "ritual_plan" ? ListChecks : Play;
  const remaining = stepEndsAt != null ? Math.max(0, Math.ceil((stepEndsAt - Date.now()) / 1000)) : 0;
  const last = phase === "ritual_run";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary">
        <Icon className="h-3 w-3" />
        {t("stepBadge", { n: stepNum })}
      </span>
      <span className="min-w-0 truncate text-[13px] font-medium" dir="auto">{label}</span>
      <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-mono text-xs font-bold tabular-nums" dir="ltr">
        {fmtMS(remaining)}
      </span>
      <Button size="sm" className="ms-auto h-8 shrink-0 gap-1.5" onClick={onNext}>
        <Play className="h-3.5 w-3.5" />
        {last ? t("enterRun") : t("stepNext")}
      </Button>
    </div>
  );
}

function fmtHMS(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtMS(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
