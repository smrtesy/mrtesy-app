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
 * right time instead of drifting. Paused time is accumulated in `pausedSeconds`
 * and the current pause is anchored at `pausedAt`.
 *
 * Phase 1 shipped the running clock; phase 2 adds the guided morning ritual
 * (inbox → plan → run) with per-step timers, plus a server reconcile so a
 * reload / second device resumes the same day. Run mode + escalations (phase 3)
 * and the end-of-day close (phase 4) layer on top.
 *
 * State survives a reload via localStorage (immediate) and is mirrored to the
 * server (`/api/tasks/work-clock/*`) for durability + the daily log. A
 * module-level singleton + subscribers mean the bar and any other reader share
 * one clock (mirrors useWorkCalendar / useDayTools).
 */

export type WorkClockPhase =
  | "idle"
  | "offer"
  | "ritual_inbox"
  | "ritual_plan"
  | "ritual_run"
  | "running"
  | "paused";

/** The morning-ritual steps, in order. */
export const RITUAL_ORDER: WorkClockPhase[] = ["ritual_inbox", "ritual_plan", "ritual_run"];
export function isRitual(phase: WorkClockPhase): boolean {
  return RITUAL_ORDER.includes(phase);
}

export interface WorkClockState {
  phase: WorkClockPhase;
  workDate: string;
  /** Epoch ms the running clock is anchored to (null while idle). */
  startedAt: number | null;
  /** Accumulated paused seconds. */
  pausedSeconds: number;
  /** Epoch ms the current pause began (null unless phase==="paused"). */
  pausedAt: number | null;
  /** Epoch ms the current ritual step's timer elapses (null outside a ritual). */
  stepEndsAt: number | null;
}

const LS_KEY = "smrttask:workclock";
const OFFERED_KEY = "smrttask:workclock:offered";

function freshState(): WorkClockState {
  return { phase: "idle", workDate: todayISO(), startedAt: null, pausedSeconds: 0, pausedAt: null, stepEndsAt: null };
}

let state: WorkClockState = freshState();
let hydrated = false;
let reconciled = false;
/** Latest resolved tool config, kept module-level so the module-scope helpers
 *  (advanceRitual) can read the step durations without prop-drilling. */
let cfg: Record<string, unknown> = {};
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

/** Load once from localStorage; a stored session from a previous day is reset.
 *  The transient `offer` phase is never restored (it re-derives each day). */
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

function numCfg(key: string, fallback: number): number {
  const v = cfg[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Duration (seconds) of a ritual step, from config. */
function stepSeconds(phase: WorkClockPhase): number {
  if (phase === "ritual_inbox") return numCfg("step_inbox_sec", 180);
  if (phase === "ritual_plan") return numCfg("step_plan_sec", 180);
  return numCfg("step_run_sec", 30); // ritual_run
}

/** Advance to the next ritual step, or into `running` once the ritual is done.
 *  Called both by the per-second timer (auto-advance) and the manual "next". */
export function advanceRitual() {
  const idx = RITUAL_ORDER.indexOf(state.phase);
  if (idx < 0) return;
  const next = RITUAL_ORDER[idx + 1];
  if (next) {
    setState({ phase: next, stepEndsAt: Date.now() + stepSeconds(next) * 1000 });
  } else {
    // Ritual complete → plain running clock (run mode arrives in phase 3).
    setState({ phase: "running", stepEndsAt: null });
    api("/api/tasks/work-clock", {
      method: "PATCH",
      body: { work_date: state.workDate, ritual_completed: true },
    }).catch(() => {});
  }
}

/** Seconds of ACTIVE work so far (frozen while paused). */
export function workedSeconds(s: WorkClockState, now: number): number {
  if (s.startedAt == null) return 0;
  const anchorEnd = s.phase === "paused" && s.pausedAt != null ? s.pausedAt : now;
  return Math.max(0, Math.floor((anchorEnd - s.startedAt) / 1000) - s.pausedSeconds);
}

/** True while the clock counts (ritual steps + running). */
function isActive(phase: WorkClockPhase): boolean {
  return isRitual(phase) || phase === "running" || phase === "paused";
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
  dismissOffer: () => void;
}

export function useWorkClock(): UseWorkClock {
  const tool = useDayTool("workclock");
  const enabled = tool.enabled;
  const config = tool.config;
  cfg = config; // keep the module snapshot current for advanceRitual

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

  // Reconcile with the server once: if a session is still open today and the
  // local clock is idle (fresh device / cleared storage / new tab before the
  // ritual), adopt the server's started_at so the clock resumes instead of
  // re-offering. Local running/paused/ritual state always wins (it carries the
  // live pause anchors the server can't).
  useEffect(() => {
    if (!enabled || reconciled) return;
    reconciled = true;
    api<{ session: { started_at: string; paused_seconds: number; closed_reason: string } | null }>(
      `/api/tasks/work-clock/today?date=${todayISO()}`,
    )
      .then(({ session }) => {
        if (!session || session.closed_reason !== "open") return;
        if (isActive(state.phase)) return; // local already tracking — don't clobber
        const startedAt = Date.parse(session.started_at);
        if (!Number.isFinite(startedAt)) return;
        setState({
          phase: "running",
          workDate: todayISO(),
          startedAt,
          pausedSeconds: session.paused_seconds ?? 0,
          pausedAt: null,
          stepEndsAt: null,
        });
      })
      .catch(() => {});
  }, [enabled]);

  // Offer the clock once per day (when enabled, idle, offer not yet shown today,
  // and the reconcile above didn't already adopt a running session).
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

  // Start the day → enter the morning ritual at step 1 (inbox). The clock starts
  // now and runs through the ritual into `running`.
  const start = useCallback(() => {
    markOffered();
    setState({
      phase: "ritual_inbox",
      workDate: todayISO(),
      startedAt: Date.now(),
      pausedSeconds: 0,
      pausedAt: null,
      stepEndsAt: Date.now() + stepSeconds("ritual_inbox") * 1000,
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

  // Heartbeat: persist the counters to the server every 30s while the clock is
  // active (a single interval regardless of how many components read the hook).
  useEffect(() => {
    if (!enabled) return;
    if (heartbeatRef.current) return;
    heartbeatRef.current = setInterval(() => {
      if (isActive(state.phase)) {
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

  return { enabled, config, state: local, showOffer, start, advance, pause, resume, stop, dismissOffer };
}
