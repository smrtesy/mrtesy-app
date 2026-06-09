/**
 * smrtPlan timeline coordinate model — shared by the board (PlanBoardClient) and
 * the per-plan task Gantt (PlanTaskGantt drill-down).
 *
 * The timeline hides the weekend (Sat + Sun): only Mon–Fri get a column, and a
 * date's pixel position is the count of *visible* columns before it × COL_PX.
 * The drag editor needs the inverse too — given a pointer's clientX, which
 * working-day column is it over — so the math lives here once and both views
 * (and any future planner surface) snap to the exact same grid.
 *
 * Direction safety: positions are expressed on the inline axis (matching CSS
 * `insetInlineStart`), so the same numbers work in RTL and LTR. The only place
 * physical pixels enter is `inlineCoordAtX`, which folds a `clientX` back onto
 * that inline axis using the element's bounding rect + the active locale.
 */

import { useCallback, useMemo } from "react";
import { parseISO, daysBetween } from "./dates";

const DAY_MS = 86_400_000;
/** Pixels per working-day column. Kept here so the board + Gantt never drift. */
export const COL_PX = 22;
/** Weekday numbers hidden from the timeline (0 = Sunday, 6 = Saturday). */
const HIDDEN_DOW = new Set([0, 6]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export interface Timeline {
  t0: Date;
  totalDays: number;
  /** Pixels per working-day column (zoomable). */
  colPx: number;
  /** Day-offset (from t0) of each visible working-day column. */
  cols: number[];
  trackWidth: number;
  dateAt: (off: number) => Date;
  offsetOf: (iso: string) => number;
  /** Column index for a day-offset (a hidden weekend lands on the next column). */
  colPos: (off: number) => number;
  /** Inline-axis pixel (matching insetInlineStart) for a day-offset. */
  xOf: (off: number) => number;
  /** Fold a physical clientX back onto the inline axis (RTL-safe). */
  inlineCoordAtX: (clientX: number, rect: DOMRect, locale: string) => number;
  /** Column the pointer sits OVER (floor), clamped to the track. */
  colUnderX: (clientX: number, rect: DOMRect, locale: string) => number;
  /** Nearest column BOUNDARY to the pointer (round), clamped to the track. */
  colBoundaryAtX: (clientX: number, rect: DOMRect, locale: string) => number;
  /** Day-offset at a column index (clamped to the track). */
  offsetAtCol: (i: number) => number;
}

/** Build the working-day column model for a [t0, t0+totalDays] window.
 *  `colPx` (default COL_PX) sets the per-column width so the board can zoom. */
export function useTimeline(t0: Date, totalDays: number, colPx: number = COL_PX): Timeline {
  const cols = useMemo(() => {
    const out: number[] = [];
    for (let o = 0; o <= totalDays; o++) {
      if (!HIDDEN_DOW.has(new Date(t0.getTime() + o * DAY_MS).getDay())) out.push(o);
    }
    return out;
  }, [t0, totalDays]);

  const dateAt = useCallback((off: number) => new Date(t0.getTime() + off * DAY_MS), [t0]);
  const offsetOf = useCallback((iso: string) => daysBetween(t0, parseISO(iso)), [t0]);

  const colPos = useCallback(
    (off: number) => {
      let lo = 0;
      let hi = cols.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cols[mid] < off) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
    [cols],
  );
  const xOf = useCallback((off: number) => colPos(off) * colPx, [colPos, colPx]);

  const inlineCoordAtX = useCallback(
    (clientX: number, rect: DOMRect, locale: string) =>
      locale === "he" ? rect.right - clientX : clientX - rect.left,
    [],
  );
  const colUnderX = useCallback(
    (clientX: number, rect: DOMRect, locale: string) =>
      clamp(Math.floor(inlineCoordAtX(clientX, rect, locale) / colPx), 0, Math.max(0, cols.length - 1)),
    [cols, inlineCoordAtX, colPx],
  );
  const colBoundaryAtX = useCallback(
    (clientX: number, rect: DOMRect, locale: string) =>
      clamp(Math.round(inlineCoordAtX(clientX, rect, locale) / colPx), 0, Math.max(0, cols.length - 1)),
    [cols, inlineCoordAtX, colPx],
  );
  const offsetAtCol = useCallback(
    (i: number) => cols[clamp(i, 0, Math.max(0, cols.length - 1))] ?? 0,
    [cols],
  );

  return {
    t0,
    totalDays,
    colPx,
    cols,
    trackWidth: cols.length * colPx,
    dateAt,
    offsetOf,
    colPos,
    xOf,
    inlineCoordAtX,
    colUnderX,
    colBoundaryAtX,
    offsetAtCol,
  };
}
