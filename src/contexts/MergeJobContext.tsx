"use client";

/**
 * Global state machine for background merge jobs.
 *
 * Lifecycle:
 *   idle   → user opens MergeModal, picks target, hits "continue to preview"
 *           — modal starts the propose() call internally.
 *   running → user hits "continue in background" inside the modal. The
 *             in-flight promise is transferred to this provider via
 *             `startJob(promise, ctx)`. Modal closes. A floating chip
 *             appears in the header indicating "AI merging in background".
 *   ready  → promise resolved successfully. The chip changes to a "ready
 *             — click to open" affordance. The proposal is persisted to
 *             sessionStorage so a page refresh doesn't lose it.
 *   error  → promise rejected. Chip turns red. Click → toast with retry
 *             hint. Job auto-cleared after dismissal.
 *
 * Only ONE job at a time. If the user kicks off a second merge while one
 * is already running/ready, the old one is dropped (with a confirmation
 * via the calling site if it matters).
 *
 * Consumers:
 *   <BackgroundMergeChip>     — renders the chip when phase != idle
 *   <MergeModal>              — listens to the provider; when phase=ready
 *                               and modal is open with no local state,
 *                               populates from the provider snapshot
 *   suggestions list pages    — call useMergeJob() to dispatch new jobs
 *                               and to listen for merge.completed events
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

// ── public types ───────────────────────────────────────────────────────────

export interface MergeJobSourceLite {
  id: string;
  title?: string | null;
  title_he?: string | null;
  task_type?: string | null;
  status?: string | null;
  ai_confidence?: number | null;
}

export interface MergeJobProposal {
  merged_title?: string;
  merged_title_he?: string;
  merged_description?: string;
  suggested_checklist?: Array<{ title: string; source_task_id?: string }>;
  recommended_priority?: "urgent" | "high" | "medium" | "low";
  priority_reason?: string;
  recommended_due_date?: string | null;
  due_date_reason?: string;
  merged_keywords?: string[];
  merged_contacts?: string[];
  already_done_warnings?: Array<{ source_task_id: string; evidence: string; confidence: number }>;
  coherence_warning?: string | null;
}

export interface MergeJobContext {
  sources: MergeJobSourceLite[];
  targetMode: "new" | "existing";
  existingTargetId: string | null;
  /** Where the job was started — used as a UX hint, not for routing. */
  startedAtPath?: string;
}

export type MergeJobState =
  | { phase: "idle" }
  | { phase: "running"; ctx: MergeJobContext; startedAt: number }
  | { phase: "ready"; ctx: MergeJobContext; proposal: MergeJobProposal; readyAt: number }
  | { phase: "error"; ctx: MergeJobContext; message: string };

interface MergeJobContextValue {
  state: MergeJobState;
  /** Hand an in-flight propose() promise to the provider. The provider
   *  takes ownership: it awaits the promise, persists the result, and
   *  surfaces the chip / completion event. */
  startJob(promise: Promise<MergeJobProposal>, ctx: MergeJobContext): void;
  /** Returns the ready snapshot (if phase=ready) and resets to idle.
   *  Used by callers that want to "consume" the job into a modal. */
  consume(): { ctx: MergeJobContext; proposal: MergeJobProposal } | null;
  /** Discard the current job, whatever its phase. */
  clear(): void;
}

// ── implementation ─────────────────────────────────────────────────────────

const Ctx = createContext<MergeJobContextValue | null>(null);

const STORAGE_KEY = "smrtesy.mergeJob.v1";

interface PersistedReadyJob {
  ctx: MergeJobContext;
  proposal: MergeJobProposal;
  readyAt: number;
}

function loadPersistedJob(): PersistedReadyJob | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedReadyJob;
    // Expire anything older than 1h to avoid stale resume of dead jobs.
    if (Date.now() - parsed.readyAt > 60 * 60 * 1000) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistJob(job: PersistedReadyJob | null) {
  if (typeof window === "undefined") return;
  if (job) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(job));
  } else {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

/** Event dispatched on `window` when a merge completes — components like
 *  MessageSuggestions listen for this to refetch their list even when
 *  they were unmounted at the time the merge happened. */
export const MERGE_COMPLETED_EVENT = "smrtesy:merge.completed";

export function dispatchMergeCompleted() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(MERGE_COMPLETED_EVENT));
  }
}

export function MergeJobProvider({ children }: { children: React.ReactNode }) {
  // Hydrate from sessionStorage on first client render so a refresh while
  // a job was 'ready' restores the chip and lets the user click to open.
  const [state, setState] = useState<MergeJobState>({ phase: "idle" });
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    const persisted = loadPersistedJob();
    if (persisted) {
      setState({
        phase: "ready",
        ctx: persisted.ctx,
        proposal: persisted.proposal,
        readyAt: persisted.readyAt,
      });
    }
  }, []);

  const startJob = useCallback((promise: Promise<MergeJobProposal>, ctx: MergeJobContext) => {
    const startedAt = Date.now();
    setState({ phase: "running", ctx, startedAt });

    promise
      .then((proposal) => {
        const readyAt = Date.now();
        const next: MergeJobState = { phase: "ready", ctx, proposal, readyAt };
        setState(next);
        persistJob({ ctx, proposal, readyAt });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "merge proposal failed";
        setState({ phase: "error", ctx, message });
      });
  }, []);

  const consume = useCallback((): { ctx: MergeJobContext; proposal: MergeJobProposal } | null => {
    let captured: { ctx: MergeJobContext; proposal: MergeJobProposal } | null = null;
    setState((cur) => {
      if (cur.phase !== "ready") return cur;
      captured = { ctx: cur.ctx, proposal: cur.proposal };
      persistJob(null);
      return { phase: "idle" };
    });
    return captured;
  }, []);

  const clear = useCallback(() => {
    persistJob(null);
    setState({ phase: "idle" });
  }, []);

  const value = useMemo<MergeJobContextValue>(
    () => ({ state, startJob, consume, clear }),
    [state, startJob, consume, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMergeJob(): MergeJobContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMergeJob must be inside <MergeJobProvider>");
  return v;
}

/** Convenience hook for components that just want to refresh themselves
 *  when a background merge completes. */
export function useMergeCompletedListener(handler: () => void) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.addEventListener(MERGE_COMPLETED_EVENT, handler);
    return () => window.removeEventListener(MERGE_COMPLETED_EVENT, handler);
  }, [handler]);
}
