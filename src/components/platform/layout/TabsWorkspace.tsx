"use client";

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  useTabsWorkspace,
  type PaneWidths,
  type WorkspaceTab,
} from "@/contexts/TabsWorkspaceContext";

import { PaneHost } from "./PaneHost";

/** Smallest a pane may be dragged to, in pixels. */
const MIN_PANE_PX = 200;

/** True if the tab is the WhatsApp reader pane (not /whatsapp/autoreply). The
 *  href is locale-prefixed and may carry a query, so compare the bare path. */
function isWhatsAppTab(tab: WorkspaceTab): boolean {
  const path = tab.href.split("?")[0].split("#")[0].replace(/\/+$/, "");
  return path.endsWith("/whatsapp");
}

/**
 * Resolve each pane's width as a fraction (0..1) of the workspace.
 *
 * - One tab fills the whole area.
 * - If every pane has an explicit width (i.e. the user has dragged a divider),
 *   use those, normalized to sum to 1.
 * - Otherwise fall back to the default: the active pane takes half, the rest
 *   share the other half.
 */
function resolveFractions(
  tabs: WorkspaceTab[],
  activeId: string | null,
  widths: PaneWidths,
): Record<string, number> {
  const n = tabs.length;
  if (n === 0) return {};
  if (n === 1) return { [tabs[0].id]: 1 };

  const allExplicit = tabs.every((t) => typeof widths[t.id] === "number");
  if (allExplicit) {
    const sum = tabs.reduce((s, t) => s + widths[t.id], 0) || 1;
    return Object.fromEntries(tabs.map((t) => [t.id, widths[t.id] / sum]));
  }
  return Object.fromEntries(
    tabs.map((t) => [t.id, t.id === activeId ? 0.5 : 0.5 / (n - 1)]),
  );
}

type DragState = {
  pinned: Record<string, number>;
  leftId: string;
  rightId: string;
  combinedLeft: number;
  combinedPx: number;
  containerW: number;
};

/**
 * Side-by-side panes for the open sidebar tabs (desktop only). The active pane
 * takes half the width by default; the rest share the other half and act as
 * previews — clicking one focuses it. The dividers between panes are draggable
 * to resize, and double-clicking a divider restores the default layout.
 */
export function TabsWorkspace() {
  const { tabs, activeId, widths, setActive, closeTab, setWidths, resetWidths } =
    useTabsWorkspace();
  const t = useTranslations("tabsWorkspace");
  const locale = useLocale();
  const isRtl = locale === "he";

  // Pin the WhatsApp pane to the physical-left edge regardless of when it was
  // opened. The panes are a flex row that follows the page direction, so the
  // left edge is the LAST DOM child in RTL and the FIRST in LTR (see the
  // getBoundingClientRect check in onHandleDown). We only reorder for display +
  // divider adjacency; the stored tab order (and its open/close semantics) is
  // untouched. Fractions/active state are keyed by id, so order doesn't affect
  // them.
  const orderedTabs = useMemo(() => {
    if (tabs.length < 2) return tabs;
    const wa = tabs.filter(isWhatsAppTab);
    if (wa.length === 0) return tabs;
    const rest = tabs.filter((tab) => !isWhatsAppTab(tab));
    return isRtl ? [...rest, ...wa] : [...wa, ...rest];
  }, [tabs, isRtl]);

  const n = orderedTabs.length;
  const fractions = resolveFractions(orderedTabs, activeId, widths);

  const dragRef = useRef<DragState | null>(null);
  const [resizingIdx, setResizingIdx] = useState<number | null>(null);

  const onHandleDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, idx: number, leftTab: WorkspaceTab, rightTab: WorkspaceTab) => {
      e.preventDefault();
      const handle = e.currentTarget;
      const paneA = handle.previousElementSibling as HTMLElement | null;
      const paneB = handle.nextElementSibling as HTMLElement | null;
      const container = handle.parentElement as HTMLElement | null;
      if (!paneA || !paneB || !container) return;

      handle.setPointerCapture(e.pointerId);
      const ra = paneA.getBoundingClientRect();
      const rb = paneB.getBoundingClientRect();
      // In RTL the first DOM pane renders on the physical right, so decide
      // left/right by measured position rather than DOM order.
      const aIsLeft = ra.left < rb.left;
      const leftRect = aIsLeft ? ra : rb;
      const rightRect = aIsLeft ? rb : ra;

      // Pin every pane to its current fraction so only this pair moves.
      const pinned = resolveFractions(tabs, activeId, widths);
      setWidths(pinned);

      dragRef.current = {
        pinned,
        leftId: aIsLeft ? leftTab.id : rightTab.id,
        rightId: aIsLeft ? rightTab.id : leftTab.id,
        combinedLeft: leftRect.left,
        combinedPx: leftRect.width + rightRect.width,
        containerW: container.clientWidth || 1,
      };
      setResizingIdx(idx);
      document.body.style.userSelect = "none";
    },
    [tabs, activeId, widths, setWidths],
  );

  const onHandleMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      const { pinned, leftId, rightId, combinedLeft, combinedPx, containerW } = drag;
      // Guard against a pair narrower than two minimums (tiny viewports): never
      // let the clamp cross over and produce a negative width on the other side.
      const min = Math.min(MIN_PANE_PX, combinedPx / 2);
      let leftPx = e.clientX - combinedLeft;
      leftPx = Math.max(min, Math.min(leftPx, combinedPx - min));
      const rightPx = combinedPx - leftPx;
      setWidths({
        ...pinned,
        [leftId]: leftPx / containerW,
        [rightId]: rightPx / containerW,
      });
    },
    [setWidths],
  );

  const onHandleUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setResizingIdx(null);
    document.body.style.userSelect = "";
  }, []);

  return (
    <div className="flex h-[100dvh] w-full overflow-x-auto">
      {orderedTabs.map((tab, i) => {
        const active = tab.id === activeId;
        const frac = fractions[tab.id] ?? 1 / n;
        return (
          <Fragment key={tab.id}>
            <section
              style={{ flexGrow: frac, flexBasis: 0, minWidth: MIN_PANE_PX }}
              className={cn(
                "flex h-full flex-shrink flex-col border-e",
                active ? "bg-background" : "bg-muted/20",
              )}
            >
              <header
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2 border-b px-2",
                  active ? "bg-muted/40" : "bg-muted/60",
                )}
              >
                <button
                  type="button"
                  onClick={() => setActive(tab.id)}
                  className="flex-1 truncate text-start text-xs font-medium text-foreground/90"
                  title={tab.label}
                >
                  {tab.label}
                </button>
                <button
                  type="button"
                  onClick={() => closeTab(tab.id)}
                  aria-label={t("close")}
                  title={t("close")}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </header>
              {/* min-h-0 lets the pane body shrink below its content height so
                  component panes scroll internally (iframes never pushed back). */}
              <div className="relative min-h-0 flex-1">
                <PaneHost tab={tab} />
                {/* Inactive panes are previews: an overlay swallows clicks and
                    focuses the pane instead of interacting with the iframe. */}
                {!active && (
                  <button
                    type="button"
                    onClick={() => setActive(tab.id)}
                    aria-label={t("focusPane")}
                    className="absolute inset-0 cursor-pointer bg-transparent"
                  />
                )}
              </div>
            </section>
            {i < n - 1 && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("resizePane")}
                onPointerDown={(e) => onHandleDown(e, i, tab, orderedTabs[i + 1])}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onDoubleClick={resetWidths}
                className="group/resize relative z-10 flex w-2 flex-none cursor-col-resize touch-none items-stretch"
              >
                <div
                  className={cn(
                    "mx-auto h-full w-0.5 transition-colors",
                    resizingIdx === i ? "bg-primary" : "bg-transparent group-hover/resize:bg-primary/40",
                  )}
                />
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}
