"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api/client";
import { useDayTool } from "@/hooks/useDayTools";
import { todayISO } from "@/lib/workdays";

/**
 * Client store for the workclock day-tool.
 *
 * The clock is TIME-BASED, not a ticking counter: we anchor `startedAt` (epoch
 * ms) and derive elapsed on every render, so a reload/navigation computes the
 * right time. Paused time accumulates in `pausedSeconds`; the current pause is
 * anchored at `pausedAt`.
 *
 * - Phase 1: the running clock.
 * - Phase 2: the guided morning ritual (inbox → plan → run) + a server reconcile.
 * - Phase 3: run mode — an ACTIVE TASK whose own clock shows in the bar, time
 *   attributed per size (quick/medium/big), and escalating time-limit alerts
 *   (soft red / popup / blocking). The active task is set automatically when a
 *   task window opens (and via a ▶ shortcut on the row).
 *
 * State survives reload via localStorage (immediate) + the server
 * (`/api/tasks/work-clock/*`) for durability + the daily log. A module-level
 * singleton + subscribers share one clock across readers.
 */

export type WorkClockPhase =
  | "idle"
  | "offer"
  | "ritual_inbox"
  | "ritual_plan"
  | "ritual_run"
  | "running"
  | "paused"
  // Day stopped but the bar stays visible (ready to run again). Distinct from
  // idle (pre-offer / declined), which hides the bar.
  | "stopped";

export type TaskSize = "quick" | "medium" | "big";

export const RITUAL_ORDER: WorkClockPhase[] = ["ritual_inbox", "ritual_plan", "ritual_run"];
export function isRitual(phase: WorkClockPhase): boolean {
  return RITUAL_ORDER.includes(phase);
}

export interface WorkClockState {
  phase: WorkClockPhase;
  workDate: string;
  startedAt: number | null;
  pausedSeconds: number;
  pausedAt: number | null;
  stepEndsAt: number | null;
  // ── run mode (phase 3) ──
  /** Task whose clock is currently running (null = none active). */
  activeTaskId: string | null;
  activeTaskSize: TaskSize | null;
  activeTaskTitle: string | null;
  /** Epoch ms the active task's span began. */
  activeStartedAt: number | null;
  /** Accumulated seconds on CLOSED spans today, per size. */
  quickSeconds: number;
  mediumSeconds: number;
  bigSeconds: number;
  /** Escalation counts (persisted to the daily log). */
  alertsSoft: number;
  alertsPopup: number;
  alertsBlock: number;
  /** Worked seconds captured at the last stop — shown on the "stopped" bar and
   *  used as the resume anchor when the day is run again. */
  dayTotalSeconds: number;
}

const LS_KEY = "smrttask:workclock";
const OFFERED_KEY = "smrttask:workclock:offered";

function freshState(): WorkClockState {
  return {
    phase: "idle", workDate: todayISO(), startedAt: null, pausedSeconds: 0, pausedAt: null, stepEndsAt: null,
    activeTaskId: null, activeTaskSize: null, activeTaskTitle: null, activeStartedAt: null,
    quickSeconds: 0, mediumSeconds: 0, bigSeconds: 0,
    alertsSoft: 0, alertsPopup: 0, alertsBlock: 0,
    dayTotalSeconds: 0,
  };
}

let state: WorkClockState = freshState();
let hydrated = false;
let reconciled = false;
let cfg: Record<string, unknown> = {};
const subscribers = new Set<(s: WorkClockState) => void>();

function notify() { for (const fn of subscribers) fn(state); }

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* durable copy is the server */ }
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkClockState;
      if (parsed && parsed.workDate === todayISO() && parsed.phase !== "offer") {
        state = { ...freshState(), ...parsed };
        if (isRitual(state.phase)) state.stepEndsAt = Date.now() + stepSeconds(state.phase) * 1000;
      }
    }
  } catch { /* corrupt → fresh */ }
}

function setState(patch: Partial<WorkClockState>) {
  state = { ...state, ...patch };
  persist();
  notify();
}

function numCfg(key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function stepSeconds(phase: WorkClockPhase): number {
  if (phase === "ritual_inbox") return numCfg("step_inbox_sec", 180);
  if (phase === "ritual_plan") return numCfg("step_plan_sec", 180);
  return numCfg("step_run_sec", 30);
}

export function advanceRitual() {
  const idx = RITUAL_ORDER.indexOf(state.phase);
  if (idx < 0) return;
  const next = RITUAL_ORDER[idx + 1];
  if (next) {
    setState({ phase: next, stepEndsAt: Date.now() + stepSeconds(next) * 1000 });
  } else {
    setState({ phase: "running", stepEndsAt: null });
    api("/api/tasks/work-clock", { method: "PATCH", body: { work_date: state.workDate, ritual_completed: true } }).catch(() => {});
  }
}

/** Seconds of ACTIVE work so far (frozen while paused). */
export function workedSeconds(s: WorkClockState, now: number): number {
  if (s.startedAt == null) return 0;
  const anchorEnd = s.phase === "paused" && s.pausedAt != null ? s.pausedAt : now;
  return Math.max(0, Math.floor((anchorEnd - s.startedAt) / 1000) - s.pausedSeconds);
}

/** Seconds on the CURRENT active-task span (frozen while paused). */
export function activeSeconds(s: WorkClockState, now: number): number {
  if (s.activeStartedAt == null) return 0;
  const end = s.phase === "paused" && s.pausedAt != null ? s.pausedAt : now;
  return Math.max(0, Math.floor((end - s.activeStartedAt) / 1000));
}

/** Total seconds attributed to a size today = closed spans + the live one. */
export function sizeSeconds(s: WorkClockState, size: TaskSize, now: number): number {
  const base = size === "quick" ? s.quickSeconds : size === "medium" ? s.mediumSeconds : s.bigSeconds;
  return base + (s.activeTaskSize === size ? activeSeconds(s, now) : 0);
}

export interface Escalation { soft: boolean; popup: boolean; block: boolean; }

/** Which escalation levels are currently tripped (pure, config-driven). */
export function escalationOf(s: WorkClockState, config: Record<string, unknown>, now: number): Escalation {
  const num = (k: string, f: number) => {
    const v = config[k]; return typeof v === "number" && Number.isFinite(v) ? v : f;
  };
  const active = activeSeconds(s, now);
  const running = s.phase === "running" || s.phase === "paused";
  const size = s.activeTaskSize;
  const quickTotal = sizeSeconds(s, "quick", now);
  return {
    soft: running && size === "quick" && active > num("limit_quick_task_sec", 300),
    popup: running && quickTotal > num("limit_quick_total_sec", 2700),
    block:
      running &&
      ((size === "medium" && active > num("limit_medium_task_sec", 2700)) ||
        (size === "big" && active > num("limit_big_task_sec", 10800))),
  };
}

function isActive(phase: WorkClockPhase): boolean {
  return isRitual(phase) || phase === "running" || phase === "paused";
}

/** Close the current active-task span into its size accumulator, and log the
 *  span to the server for the learning view (fire-and-forget). */
function flushActiveSpan() {
  if (state.activeTaskId == null || state.activeTaskSize == null || state.activeStartedAt == null) return {};
  const secs = activeSeconds(state, Date.now());
  if (secs > 0) {
    api("/api/tasks/work-clock/span", {
      method: "POST",
      body: {
        work_date: state.workDate,
        task_id: state.activeTaskId,
        size: state.activeTaskSize,
        seconds: secs,
        ended_at: new Date().toISOString(),
      },
    }).catch(() => {});
  }
  const key = state.activeTaskSize === "quick" ? "quickSeconds" : state.activeTaskSize === "medium" ? "mediumSeconds" : "bigSeconds";
  return { [key]: (state[key as "quickSeconds"] as number) + secs } as Partial<WorkClockState>;
}

export interface UseWorkClock {
  enabled: boolean;
  config: Record<string, unknown>;
  state: WorkClockState;
  showOffer: boolean;
  start: () => void;
  advance: () => void;
  pause: () => void;
  resume: () => void;
  stop: (reason?: "manual" | "auto" | "extended") => void;
  restart: () => void;
  dismissOffer: () => void;
  /** Run mode: set / change the active task (its clock starts now). No-op
   *  unless the clock is running (so opening a task off-clock doesn't start one). */
  setActiveTask: (taskId: string, size: TaskSize, title: string) => void;
  clearActiveTask: () => void;
  bumpAlert: (level: "soft" | "popup" | "block") => void;
}

export function useWorkClock(): UseWorkClock {
  const tool = useDayTool("workclock");
  const enabled = tool.enabled;
  const config = tool.config;
  cfg = config;

  const [local, setLocal] = useState<WorkClockState>(() => { hydrate(); return state; });
  const [offerChecked, setOfferChecked] = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    subscribers.add(setLocal);
    setLocal(state);
    return () => { subscribers.delete(setLocal); };
  }, []);

  useEffect(() => {
    if (!enabled || reconciled) return;
    reconciled = true;
    api<{ session: { started_at: string; paused_seconds: number; closed_reason: string } | null }>(
      `/api/tasks/work-clock/today?date=${todayISO()}`,
    )
      .then(({ session }) => {
        if (!session || session.closed_reason !== "open") return;
        if (isActive(state.phase)) return;
        const startedAt = Date.parse(session.started_at);
        if (!Number.isFinite(startedAt)) return;
        setState({ phase: "running", workDate: todayISO(), startedAt, pausedSeconds: session.paused_seconds ?? 0, pausedAt: null, stepEndsAt: null });
      })
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!enabled || config.offer_daily === false) return;
    if (state.phase !== "idle") return;
    try {
      if (localStorage.getItem(OFFERED_KEY) === todayISO()) { setOfferChecked(true); return; }
    } catch { /* ignore */ }
    setOfferChecked(true);
    setState({ phase: "offer" });
  }, [enabled, config.offer_daily, local.phase]);

  const markOffered = () => {
    try { localStorage.setItem(OFFERED_KEY, todayISO()); } catch { /* ignore */ }
  };

  const start = useCallback(() => {
    markOffered();
    setState({
      phase: "ritual_inbox", workDate: todayISO(), startedAt: Date.now(),
      pausedSeconds: 0, pausedAt: null, stepEndsAt: Date.now() + stepSeconds("ritual_inbox") * 1000,
      activeTaskId: null, activeTaskSize: null, activeTaskTitle: null, activeStartedAt: null,
    });
    api("/api/tasks/work-clock/start", { method: "POST", body: { work_date: todayISO() } }).catch(() => {});
  }, []);

  const advance = useCallback(() => { advanceRitual(); }, []);

  const pause = useCallback(() => {
    if (state.phase !== "running") return;
    setState({ phase: "paused", pausedAt: Date.now() });
  }, []);

  const resume = useCallback(() => {
    if (state.phase !== "paused" || state.pausedAt == null) return;
    const added = Math.floor((Date.now() - state.pausedAt) / 1000);
    // Push the pause gap forward on the active span too, so its clock doesn't
    // count the paused time (both anchors shift by the same gap).
    const patch: Partial<WorkClockState> = { phase: "running", pausedSeconds: state.pausedSeconds + added, pausedAt: null };
    if (state.activeStartedAt != null) patch.activeStartedAt = state.activeStartedAt + added * 1000;
    setState(patch);
  }, []);

  const stop = useCallback((reason: "manual" | "auto" | "extended" = "manual") => {
    const now = Date.now();
    const worked = workedSeconds(state, now);
    const paused = state.pausedSeconds;
    // Log the final active-task span before we drop the anchors (otherwise the
    // day's last span never lands in work_task_spans). Side-effect only.
    flushActiveSpan();
    // Final flush: persist the per-size totals incl. the live span (the stop
    // route only takes worked/paused, so send the size breakdown as a last
    // heartbeat first). Both upsert the same row on distinct columns.
    api("/api/tasks/work-clock", {
      method: "PATCH",
      body: {
        work_date: state.workDate,
        quick_seconds: sizeSeconds(state, "quick", now),
        medium_seconds: sizeSeconds(state, "medium", now),
        big_seconds: sizeSeconds(state, "big", now),
        alerts_soft: state.alertsSoft, alerts_popup: state.alertsPopup, alerts_block: state.alertsBlock,
      },
    }).catch(() => {});
    api("/api/tasks/work-clock/stop", {
      method: "POST",
      body: { work_date: state.workDate, reason, worked_seconds: worked, paused_seconds: paused },
    }).catch(() => {});
    markOffered();
    // Keep the bar visible in a "stopped" (ready) state instead of vanishing:
    // freeze the day total, clear the run anchors, drop the active task.
    setState({
      phase: "stopped", startedAt: null, pausedAt: null,
      activeTaskId: null, activeTaskSize: null, activeTaskTitle: null, activeStartedAt: null,
      dayTotalSeconds: worked,
    });
  }, []);

  // Run the day again after a stop — continue from the frozen total (no morning
  // ritual; that already happened) and reopen the same server session.
  const restart = useCallback(() => {
    const anchor = Date.now() - state.dayTotalSeconds * 1000;
    setState({ phase: "running", startedAt: anchor, pausedSeconds: 0, pausedAt: null });
    api("/api/tasks/work-clock/start", { method: "POST", body: { work_date: todayISO() } }).catch(() => {});
  }, []);

  const dismissOffer = useCallback(() => { markOffered(); setState({ phase: "idle" }); }, []);

  const setActiveTask = useCallback((taskId: string, size: TaskSize, title: string) => {
    if (state.phase !== "running" && state.phase !== "paused") return; // run mode only
    if (state.activeTaskId === taskId && state.activeTaskSize === size) return;
    // Anchor at the pause instant while paused so the new span doesn't start
    // late once resume() shifts anchors forward by the pause gap.
    const anchor = state.phase === "paused" && state.pausedAt != null ? state.pausedAt : Date.now();
    setState({ ...flushActiveSpan(), activeTaskId: taskId, activeTaskSize: size, activeTaskTitle: title, activeStartedAt: anchor });
  }, []);

  const clearActiveTask = useCallback(() => {
    if (state.activeTaskId == null) return;
    setState({ ...flushActiveSpan(), activeTaskId: null, activeTaskSize: null, activeTaskTitle: null, activeStartedAt: null });
  }, []);

  const bumpAlert = useCallback((level: "soft" | "popup" | "block") => {
    const key = level === "soft" ? "alertsSoft" : level === "popup" ? "alertsPopup" : "alertsBlock";
    setState({ [key]: (state[key as "alertsSoft"] as number) + 1 } as Partial<WorkClockState>);
  }, []);

  // Heartbeat: persist counters (incl. per-size totals + alert counts) every 30s.
  useEffect(() => {
    if (!enabled) return;
    if (heartbeatRef.current) return;
    heartbeatRef.current = setInterval(() => {
      if (isActive(state.phase)) {
        const now = Date.now();
        api("/api/tasks/work-clock", {
          method: "PATCH",
          body: {
            work_date: state.workDate,
            worked_seconds: workedSeconds(state, now),
            paused_seconds: state.pausedSeconds,
            quick_seconds: sizeSeconds(state, "quick", now),
            medium_seconds: sizeSeconds(state, "medium", now),
            big_seconds: sizeSeconds(state, "big", now),
            alerts_soft: state.alertsSoft,
            alerts_popup: state.alertsPopup,
            alerts_block: state.alertsBlock,
          },
        }).catch(() => {});
      }
    }, 30_000);
    return () => {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = undefined; }
    };
  }, [enabled]);

  const showOffer = enabled && local.phase === "offer" && offerChecked;

  return {
    enabled, config, state: local, showOffer,
    start, advance, pause, resume, stop, restart, dismissOffer,
    setActiveTask, clearActiveTask, bumpAlert,
  };
}
