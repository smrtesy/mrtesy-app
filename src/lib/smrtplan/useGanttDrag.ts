/**
 * useGanttDrag — pointer-driven drag/resize for timeline bars, snapped to the
 * working-day grid. Shared by the plan board (drag a plan window) and the
 * per-plan task Gantt (drag a task bar). It reports a live column preview while
 * dragging and commits the final day-offsets on drop; the caller owns what those
 * offsets mean (plan dates, a task's due/duration, a milestone point, …).
 *
 * Native pointer events (not @dnd-kit) on purpose: a Gantt needs precise pixel→
 * column mapping against a scrolling track, which the sortable/list abstractions
 * don't model. Direction is handled by the Timeline (RTL-safe inline axis).
 */

"use client";

import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Timeline } from "./timeline";
import { COL_PX } from "./timeline";

export type DragMode = "move" | "resize-start" | "resize-end";

export interface DragPreview {
  id: string;
  startCol: number;
  endCol: number;
}

interface DragInternal {
  id: string;
  mode: DragMode;
  startCol0: number;
  endCol0: number;
  grabCol: number;
}

export function useGanttDrag(
  tl: Timeline,
  locale: string,
  trackRef: RefObject<HTMLElement | null>,
  onCommit: (id: string, startOff: number, endOff: number) => void,
) {
  const [preview, setPreview] = useState<DragPreview | null>(null);
  const moved = useRef(false);
  const state = useRef<DragInternal | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent, id: string, startOff: number, endOff: number, mode: DragMode) => {
      const track = trackRef.current;
      if (!track) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = track.getBoundingClientRect();
      const startCol = tl.colPos(startOff);
      const endCol = tl.colPos(endOff);
      state.current = { id, mode, startCol0: startCol, endCol0: endCol, grabCol: tl.colUnderX(e.clientX, rect, locale) };
      moved.current = false;
      setPreview({ id, startCol, endCol });

      const maxCol = Math.max(0, tl.cols.length - 1);
      const move = (ev: PointerEvent) => {
        const s = state.current;
        if (!s) return;
        moved.current = true;
        const r = track.getBoundingClientRect();
        if (s.mode === "move") {
          const cur = tl.colUnderX(ev.clientX, r, locale);
          // Keep the whole bar on-track when shifting both edges together.
          const delta = Math.max(-s.startCol0, Math.min(maxCol - s.endCol0, cur - s.grabCol));
          setPreview({ id: s.id, startCol: s.startCol0 + delta, endCol: s.endCol0 + delta });
        } else if (s.mode === "resize-start") {
          const c = Math.min(tl.colBoundaryAtX(ev.clientX, r, locale), s.endCol0);
          setPreview({ id: s.id, startCol: c, endCol: s.endCol0 });
        } else {
          const c = Math.max(tl.colBoundaryAtX(ev.clientX, r, locale), s.startCol0);
          setPreview({ id: s.id, startCol: s.startCol0, endCol: c });
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        const s = state.current;
        state.current = null;
        setPreview((p) => {
          if (s && moved.current && p) onCommit(s.id, tl.offsetAtCol(p.startCol), tl.offsetAtCol(p.endCol));
          return null;
        });
        // Keep `moved` true through the synthetic click on the dragged element
        // (so it's suppressed), then clear it so later plain clicks register.
        setTimeout(() => {
          moved.current = false;
        }, 0);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [tl, locale, trackRef, onCommit],
  );

  /** True if the last pointer interaction actually moved (to suppress a click). */
  const didMove = useCallback(() => moved.current, []);

  return { preview, onPointerDown, didMove };
}

/** Inline-axis pixel width for a [startCol, endCol] span (min one column). */
export function spanWidth(startCol: number, endCol: number): number {
  return Math.max(COL_PX, (endCol - startCol) * COL_PX);
}
