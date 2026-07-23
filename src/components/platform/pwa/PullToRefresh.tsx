"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

/**
 * Pull-to-refresh for the installed PWA.
 *
 * When smrtesy is added to the home screen it runs in `display-mode: standalone`
 * — no browser chrome, and therefore no browser-provided pull-to-refresh. On top
 * of that, globals.css sets `overscroll-behavior-y: none` in standalone mode, so
 * even the rubber-band overscroll is gone. The result: dragging down at the top
 * of a screen did nothing. This component restores the gesture in JS.
 *
 * It is deliberately inert everywhere it isn't needed:
 *  - a normal browser tab already has the browser's own pull-to-refresh, so we
 *    gate strictly on standalone (Android `display-mode`, iOS `navigator.standalone`);
 *  - inside a tabs-workspace iframe pane (framed) we bail, so a pane pull never
 *    reloads the whole shell;
 *  - the native Android WebView app has its own SwipeRefreshLayout and does not
 *    report standalone, so the two never fight.
 *
 * The gesture only owns a downward drag that starts while every scrollable
 * ancestor of the touch — and the document itself — is at its top; otherwise the
 * touch scrolls content as usual (important for chat / inner-scroll screens where
 * the window never scrolls).
 */

const THRESHOLD = 70; // px of pull needed to commit to a refresh
const MAX_PULL = 130; // cap the indicator travel
const RESISTANCE = 0.5; // the drag feels heavier than the finger

export function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Mirrors of the state read inside the native touch handlers, so the effect
  // can attach once (stable deps) without capturing stale values.
  const pullRef = useRef(0);
  const refreshingRef = useRef(false);
  const activeRef = useRef(false); // this gesture is eligible to become a pull
  const pullingRef = useRef(false); // we've committed to owning the drag
  const startYRef = useRef(0);
  const startXRef = useRef(0);

  const setPullBoth = (v: number) => {
    pullRef.current = v;
    setPull(v);
  };

  useEffect(() => {
    let standalone = false;
    try {
      standalone =
        window.matchMedia("(display-mode: standalone)").matches ||
        // iOS Safari home-screen apps
        (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    } catch {
      standalone = false;
    }
    let framed = true;
    try {
      framed = window.self !== window.top;
    } catch {
      framed = true; // cross-origin access throws → treat as framed
    }
    if (!standalone || framed) return;

    // Walk up from the touched node: if any scrollable ancestor is scrolled down,
    // this pull belongs to that container, not to refresh. Then require the
    // document/window itself to be at the very top.
    const canPullFrom = (target: EventTarget | null): boolean => {
      let el = target as HTMLElement | null;
      while (el && el !== document.body && el !== document.documentElement) {
        const oy = window.getComputedStyle(el).overflowY;
        const scrollable =
          (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight;
        if (scrollable && el.scrollTop > 0) return false;
        el = el.parentElement;
      }
      return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
    };

    const reset = () => {
      activeRef.current = false;
      pullingRef.current = false;
      setDragging(false);
      setPullBoth(0);
    };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current) return; // mid-refresh: keep the spinner, ignore
      if (e.touches.length !== 1) {
        // a second finger (e.g. pinch) abandons any pull in progress
        reset();
        return;
      }
      startYRef.current = e.touches[0].clientY;
      startXRef.current = e.touches[0].clientX;
      pullingRef.current = false;
      activeRef.current = canPullFrom(e.target);
    };

    const onMove = (e: TouchEvent) => {
      if (!activeRef.current || refreshingRef.current) return;
      if (e.touches.length !== 1) {
        reset();
        return;
      }
      const dy = e.touches[0].clientY - startYRef.current;
      const dx = e.touches[0].clientX - startXRef.current;
      if (dy <= 0) {
        // upward / neutral — hand the gesture back to normal scrolling
        if (pullingRef.current) {
          pullingRef.current = false;
          setDragging(false);
          setPullBoth(0);
        }
        return;
      }
      if (!pullingRef.current) {
        // Only claim a mostly-vertical intent; a horizontal-ish drag (carousels,
        // horizontal scrollers) at the top of the page stays with the content.
        if (dy < Math.abs(dx)) return;
        pullingRef.current = true;
        setDragging(true);
      }
      setPullBoth(Math.min(MAX_PULL, dy * RESISTANCE));
      // We own the drag now — stop the page from moving under the indicator.
      e.preventDefault();
    };

    const onEnd = () => {
      if (!activeRef.current) {
        // gesture was abandoned (e.g. multi-touch) but left a partial pull —
        // snap the indicator back so it can't get stuck on screen
        if (pullRef.current > 0 && !refreshingRef.current) reset();
        return;
      }
      if (pullingRef.current && pullRef.current >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        setDragging(false);
        setPullBoth(THRESHOLD);
        // Let the spinner paint, then reload for guaranteed-fresh data across
        // every screen (not all screens share one refetch mechanism).
        window.setTimeout(() => window.location.reload(), 150);
      } else {
        reset();
      }
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", reset);
    };
  }, []);

  if (pull <= 0 && !refreshing) return null;

  const progress = Math.min(1, pull / THRESHOLD);
  const spinning = refreshing || pull >= THRESHOLD;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center"
      style={{
        transform: `translateY(${pull}px)`,
        opacity: refreshing ? 1 : progress,
        transition: dragging ? "none" : "transform 200ms ease, opacity 200ms ease",
        // sit just under the notch / status bar in standalone
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <div className="mt-2 rounded-full border bg-card p-2 shadow-md">
        <Loader2
          className={`h-5 w-5 text-primary ${spinning ? "animate-spin" : ""}`}
          style={spinning ? undefined : { transform: `rotate(${pull * 2.5}deg)` }}
        />
      </div>
    </div>
  );
}
