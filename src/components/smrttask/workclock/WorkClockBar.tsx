"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Clock, Play, Pause, Square, Sun, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkClock, workedSeconds } from "@/hooks/useWorkClock";

/**
 * The workclock bar — a thin strip at the top of the workspace, shown only
 * while the tool is on and a clock session is active/offered (quiet by default,
 * per the compact-UI rule). Phase 1: the once-a-day offer + a running work
 * clock with pause/resume/stop. The morning ritual (phase 2), run mode +
 * escalations (phase 3) and the end-of-day close (phase 4) extend this.
 */
export function WorkClockBar() {
  const t = useTranslations("workclock");
  const locale = useLocale();
  const dir = locale === "he" ? "rtl" : "ltr";
  const { enabled, state, showOffer, start, pause, resume, stop, dismissOffer } = useWorkClock();

  // Local 1s tick so the running clock updates on screen (the store itself is
  // time-anchored, not a counter — see useWorkClock).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state.phase !== "running") return;
    const iv = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [state.phase]);

  // Render nothing until mounted: the clock state is hydrated from localStorage
  // on the client, so a server-rendered null must match the first client render
  // (avoids a hydration mismatch when a session was persisted mid-day).
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  if (!enabled || !mounted) return null;

  // ── the once-a-day offer ──────────────────────────────────────────────────
  if (showOffer) {
    return (
      <div
        dir={dir}
        className="flex items-center gap-3 border-b border-primary/25 bg-primary/5 px-4 py-2 text-sm"
      >
        <Sun className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate" dir="auto">{t("offerTitle")}</span>
        <Button size="sm" className="h-8 gap-1.5" onClick={start}>
          <Play className="h-3.5 w-3.5" />
          {t("offerStart")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-muted-foreground"
          onClick={dismissOffer}
        >
          {t("offerLater")}
        </Button>
      </div>
    );
  }

  if (state.phase !== "running" && state.phase !== "paused") return null;

  const paused = state.phase === "paused";
  const secs = workedSeconds(state, Date.now());
  const clock = fmtHMS(secs);

  return (
    <div
      dir={dir}
      className={cn(
        "flex items-center gap-3 border-b px-4 py-1.5 text-sm transition-colors",
        paused ? "bg-muted/40" : "bg-card",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid h-6 w-6 place-items-center rounded-md",
            paused ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
          )}
        >
          <Clock className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-[15px] font-semibold tabular-nums" dir="ltr">{clock}</span>
        <span className="text-[10px] font-medium text-muted-foreground/70">{t("dayClock")}</span>
      </div>

      {paused && (
        <span className="text-xs font-medium text-status-warn" dir="auto">{t("pausedLabel")}</span>
      )}

      <div className="ms-auto flex items-center gap-1.5">
        {paused ? (
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

function fmtHMS(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
