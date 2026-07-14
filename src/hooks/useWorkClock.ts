"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api/client";
import { useDayTool } from "@/hooks/useDayTools";
import { todayISO } from "@/lib/workdays";

/**
 * Client store for the workclock day-tool (phase 1: the running work clock).
 *
 * The clock is TIME-BASED, not a ticking counter: we anchor `startedAt` (epoch
 * ms) and derive elapsed on every render, so a reload/navigation computes the
 * right time instead of drifting. Paused time is accumulated in `pausedSeconds`
 * and the current pause is anchored at `pausedAt`.
 *
 * State survives a reload via localStorage (immediate) and is mirrored to the
 * server (`/api/work-clock/*`) for durability + the daily log. A module-level
 * singleton + subscribers mean the bar and any other reader share one clock
 * (mirrors useWorkCalendar / useDayTools).
 *
 * Later phases layer the morning ritual (phase 2), run mode + active-task
 * tracking + escalations (phase 3), and the end-of-day close (phase 4) on top
 * of this state.
 */

export type WorkClockPhase = "idle" | "offer" | "running" | "paused";

export interface WorkClockState {
  phase: WorkClockPhase;
  workDate: string;
  /** Epoch ms the running clock is anchored to (null while idle). */
  startedAt: number | null;
  /** Accumulated paused seconds. */
  pausedSeconds: number;
  /** Epoch ms the current pause began (null unless phase==="paused"). */
  pausedAt: number | null;
}

const LS_KEY = "smrttask:workclock";
const OFFERED_KEY = "smrttask:workclock:offered";

function freshState(): WorkClockState {
  return { phase: "idle", workDate: todayISO(), startedAt: null, pausedSeconds: 0, pausedAt: null };
}

let state: WorkClockState = freshState();
let hydrated = false;
const subscribers = new Set<(s: WorkClockState) => void>();

function notify() {
  for (const fn of subscribers) fn(state);
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage full / unavailable — the server copy is the durable one */
  }
}

/** Load once from localStorage; a stored session from a previous day is reset. */
function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as WorkClockState;
      if (parsed && parsed.workDate === todayISO() && parsed.phase !== "offer") {
        state = { ...freshState(), ...parsed };
      }
    }
  } catch {
    /* corrupt value — start fresh */
  }
}

function setState(patch: Partial<WorkClockState>) {
  state = { ...state, ...patch };
  persist();
  notify();
}

/** Seconds of ACTIVE work so far (frozen while paused). */
export function workedSeconds(s: WorkClockState, now: number): number {
  if (s.startedAt == null) return 0;
  const anchorEnd = s.phase === "paused" && s.pausedAt != null ? s.pausedAt : now;
  return Math.max(0, Math.floor((anchorEnd - s.startedAt) / 1000) - s.pausedSeconds);
}

export interface UseWorkClock {
  enabled: boolean;
  config: Record<string, unknown>;
  state: WorkClockState;
  /** Should the once-a-day "start work clock?" offer show right now? */
  showOffer: boolean;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: (reason?: "manual" | "auto" | "extended") => void;
  dismissOffer: () => void;
}

export function useWorkClock(): UseWorkClock {
  const tool = useDayTool("workclock");
  const enabled = tool.enabled;
  const config = tool.config;

  const [local, setLocal] = useState<WorkClockState>(() => {
    hydrate();
    return state;
  });
  const [offerChecked, setOfferChecked] = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    subscribers.add(setLocal);
    setLocal(state);
    return () => { subscribers.delete(setLocal); };
  }, []);

  // Offer the clock once per day (when enabled, idle, offer not yet shown today).
  useEffect(() => {
    if (!enabled || config.offer_daily === false) return;
    if (state.phase !== "idle") return;
    try {
      if (localStorage.getItem(OFFERED_KEY) === todayISO()) { setOfferChecked(true); return; }
    } catch { /* ignore */ }
    setOfferChecked(true);
    setState({ phase: "offer" });
  }, [enabled, config.offer_daily]);

  const markOffered = () => {
    try { localStorage.setItem(OFFERED_KEY, todayISO()); } catch { /* ignore */ }
  };

  const start = useCallback(() => {
    markOffered();
    setState({ phase: "running", workDate: todayISO(), startedAt: Date.now(), pausedSeconds: 0, pausedAt: null });
    api("/api/tasks/work-clock/start", { method: "POST", body: { work_date: todayISO() } }).catch(() => {});
  }, []);

  const pause = useCallback(() => {
    if (state.phase !== "running") return;
    setState({ phase: "paused", pausedAt: Date.now() });
  }, []);

  const resume = useCallback(() => {
    if (state.phase !== "paused" || state.pausedAt == null) return;
    const added = Math.floor((Date.now() - state.pausedAt) / 1000);
    setState({ phase: "running", pausedSeconds: state.pausedSeconds + added, pausedAt: null });
  }, []);

  const stop = useCallback((reason: "manual" | "auto" | "extended" = "manual") => {
    const worked = workedSeconds(state, Date.now());
    const paused = state.pausedSeconds;
    api("/api/tasks/work-clock/stop", {
      method: "POST",
      body: { work_date: state.workDate, reason, worked_seconds: worked, paused_seconds: paused },
    }).catch(() => {});
    markOffered();
    setState({ ...freshState() });
  }, []);

  const dismissOffer = useCallback(() => {
    markOffered();
    setState({ phase: "idle" });
  }, []);

  // Heartbeat: persist the counters to the server every 30s while running (a
  // single interval regardless of how many components read the hook).
  useEffect(() => {
    if (!enabled) return;
    if (heartbeatRef.current) return;
    heartbeatRef.current = setInterval(() => {
      if (state.phase === "running" || state.phase === "paused") {
        api("/api/tasks/work-clock", {
          method: "PATCH",
          body: {
            work_date: state.workDate,
            worked_seconds: workedSeconds(state, Date.now()),
            paused_seconds: state.pausedSeconds,
          },
        }).catch(() => {});
      }
    }, 30_000);
    return () => {
      if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = undefined; }
    };
  }, [enabled]);

  const showOffer = enabled && local.phase === "offer" && offerChecked;

  return { enabled, config, state: local, showOffer, start, pause, resume, stop, dismissOffer };
}
