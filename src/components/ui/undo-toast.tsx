"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * A countdown "you can still undo" toast.
 *
 * The action it announces has ALREADY been applied (optimistically + on the
 * server) by the caller — this toast only opens a short window in which the
 * user can reverse it (`onUndo`) or, for the auto-snooze case, pick a different
 * date (`onChange`). A ring fills over `durationMs`; when it completes the
 * toast dismisses itself and the action simply stands.
 *
 * This is the single, shared pattern for every reversible change in smrtTask
 * (completing a task, the due-date → auto-snooze, …) so they all look and
 * behave identically.
 */

const RADIUS = 10;
const CIRC = 2 * Math.PI * RADIUS;
const DEFAULT_DURATION_MS = 5000;

export interface UndoToastOptions {
  /** The line of text shown next to the wheel. */
  message: string;
  /** Label for the reverse button (e.g. "ביטול"). */
  undoLabel: string;
  /** Reverses the action. Runs at most once. */
  onUndo: () => void;
  /** Optional secondary action label (e.g. "שנה תאריך"). */
  changeLabel?: string;
  /** Optional secondary action (e.g. open a date picker). Runs at most once. */
  onChange?: () => void;
  /** How long the undo window stays open. Default 5000ms. */
  durationMs?: number;
}

/** Show the countdown undo toast. */
export function undoToast(opts: UndoToastOptions) {
  // duration: Infinity — the inner component owns the lifecycle and dismisses
  // itself when the ring completes, so sonner must not auto-close it early.
  toast.custom((id) => <UndoToastBody id={id} {...opts} />, { duration: Infinity });
}

function UndoToastBody({
  id,
  message,
  undoLabel,
  onUndo,
  changeLabel,
  onChange,
  durationMs = DEFAULT_DURATION_MS,
}: UndoToastOptions & { id: string | number }) {
  // Guard so the two buttons (and the auto-expire) each fire at most once.
  const actedRef = useRef(false);
  const [offset, setOffset] = useState(CIRC);

  // Fill the ring from empty to full over the window (one CSS transition,
  // kicked off on the next frame so the transition actually animates).
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOffset(0));
    return () => cancelAnimationFrame(raf);
  }, []);

  // Auto-dismiss when the window elapses; the action just stands.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (actedRef.current) return;
      actedRef.current = true;
      toast.dismiss(id);
    }, durationMs);
    return () => clearTimeout(timer);
  }, [id, durationMs]);

  function fire(handler?: () => void) {
    if (actedRef.current) return;
    actedRef.current = true;
    handler?.();
    toast.dismiss(id);
  }

  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-card-foreground shadow-lg">
      <svg className="h-6 w-6 shrink-0 -rotate-90" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r={RADIUS} fill="none" strokeWidth="2.5" className="stroke-muted" />
        <circle
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="stroke-primary"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          style={{ transition: `stroke-dashoffset ${durationMs}ms linear` }}
        />
      </svg>

      <span className="flex-1 text-sm" dir="auto">{message}</span>

      {changeLabel && onChange && (
        <button
          type="button"
          onClick={() => fire(onChange)}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-foreground hover:bg-accent"
        >
          {changeLabel}
        </button>
      )}
      <button
        type="button"
        onClick={() => fire(onUndo)}
        className={cn(
          "shrink-0 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-accent",
        )}
      >
        {undoLabel}
      </button>
    </div>
  );
}
