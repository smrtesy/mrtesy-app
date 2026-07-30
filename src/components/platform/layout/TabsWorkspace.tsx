"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, MoreVertical, PanelLeftClose, PanelRightClose, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  useTabsWorkspace,
  type PaneWidths,
  type WorkspaceTab,
} from "@/contexts/TabsWorkspaceContext";
import { stripLocale } from "@/lib/panes/nav";
import { navIconFor } from "@/lib/panes/route-label";

import { PaneHost } from "./PaneHost";

/** Smallest a pane may be dragged to, in pixels. */
const MIN_PANE_PX = 200;

/** Fixed width of a parked (rail) tab, in pixels. Wide enough for the vertical
 *  title and the close affordance, narrow enough to stay out of the way. */
const RAIL_PX = 44;

/** True if the tab is the WhatsApp reader pane (not /whatsapp/autoreply). The
 *  href is locale-prefixed and may carry a query, so compare the bare path. */
function isWhatsAppTab(tab: WorkspaceTab): boolean {
  const path = tab.href.split("?")[0].split("#")[0].replace(/\/+$/, "");
  return path.endsWith("/whatsapp");
}

/**
 * Resolve each EXPANDED pane's width as a fraction (0..1) of the space left for
 * expanded panes (rails are fixed-width and excluded from this).
 *
 * - One expanded pane fills the whole area.
 * - If every expanded pane has an explicit width (i.e. the user has dragged a
 *   divider), use those, normalized to sum to 1.
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
  const activeExpanded = tabs.some((t) => t.id === activeId);
  return Object.fromEntries(
    tabs.map((t) => [
      t.id,
      activeExpanded ? (t.id === activeId ? 0.5 : 0.5 / (n - 1)) : 1 / n,
    ]),
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
 * Per-pane controls, collapsed into a single grip in the pane's top-inline-end
 * corner. Design goals (user, 2026-07): the grip is the ONLY thing that
 * reserves the corner — grip-sized, drawn on top (z-70) so page content can
 * never hide it — and the positioning wrapper is `pointer-events-none`, so a
 * click anywhere in the corner except the grip itself falls through to the
 * page beneath. Hover / keyboard-focus / touch-tap the grip and the actions
 * drop straight DOWN in a narrow column (close, park-to-rail when another
 * expanded pane remains, maximize), keeping the always-on footprint tiny.
 *
 * The reveal is driven by a single `open` state (not CSS :hover), because the
 * pointer-events-none wrapper would swallow hover events on its transparent
 * area; the interactive inner column carries the mouse/focus handlers, and the
 * action buttons are only mounted while open so the collapsed grip reserves
 * nothing below it. A maximized (solo) pane shows only the restore control,
 * always visible — it is the way back (Escape also restores, see TabsWorkspace).
 */
function PaneControls({
  tab,
  solo,
  canCollapse,
  onClose,
  onCollapse,
  onToggleSolo,
}: {
  tab: WorkspaceTab;
  solo: boolean;
  canCollapse: boolean;
  onClose: () => void;
  onCollapse: () => void;
  onToggleSolo: () => void;
}) {
  const t = useTranslations("tabsWorkspace");
  const locale = useLocale();
  const CollapseIcon = locale === "he" ? PanelRightClose : PanelLeftClose;
  const [open, setOpen] = useState(false);

  const actionBtn =
    "pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground";

  // Solo: one always-visible restore button — the only way back besides Escape.
  if (solo) {
    return (
      <div className="pointer-events-none absolute end-0 top-0 z-[70] p-1.5">
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
          aria-label={t("restorePane")}
          title={t("restorePane")}
          className={actionBtn}
        >
          <Minimize2 className="h-4 w-4" />
        </button>
      </div>
    );
  }

  const closeTitle = tab.label ? `${t("close")} · ${tab.label}` : t("close");

  return (
    <div className="pointer-events-none absolute end-0 top-0 z-[70] p-1.5">
      {/* Only this inner column is interactive. Collapsed it is exactly the
          grip's size; the action buttons mount only while open, so nothing
          below the grip captures clicks meant for the page. */}
      <div
        className="pointer-events-auto flex w-7 flex-col items-end gap-1"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
          aria-label={t("paneControls")}
          title={t("paneControls")}
          aria-expanded={open}
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-md bg-background/60 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {open && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              aria-label={t("close")}
              title={closeTitle}
              className={actionBtn}
            >
              <X className="h-4 w-4" />
            </button>
            {canCollapse && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onCollapse(); }}
                aria-label={t("collapsePane")}
                title={t("collapsePane")}
                className={actionBtn}
              >
                <CollapseIcon className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleSolo(); }}
              aria-label={t("maximizePane")}
              title={t("maximizePane")}
              className={actionBtn}
            >
              <Maximize2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Side-by-side panes for the open sidebar tabs (desktop only).
 *
 * Opening a page focuses it and parks every other tab as a narrow "rail" that
 * shows only the title (see openTab). Clicking a rail expands it back beside
 * the others, so several panes — including WhatsApp — can sit side by side on
 * demand. Among the expanded panes the active one takes half the width by
 * default; the rest share the other half and act as previews. Dividers between
 * two adjacent expanded panes are draggable, and double-clicking a divider
 * restores the default layout.
 */
export function TabsWorkspace() {
  const {
    tabs,
    activeId,
    widths,
    soloId,
    collapsedIds,
    setActive,
    closeTab,
    expandTab,
    collapseTab,
    setWidths,
    resetWidths,
    toggleSolo,
  } = useTabsWorkspace();
  const t = useTranslations("tabsWorkspace");
  const locale = useLocale();
  const isRtl = locale === "he";

  // Escape leaves maximized view — the pane covers the whole workspace, so the
  // way back has to be reachable without hunting for the button.
  useEffect(() => {
    if (!soloId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") toggleSolo(soloId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [soloId, toggleSolo]);

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

  // Maximized: render only that pane. The others stay open (and keep their
  // widths) — they are hidden, not closed.
  const solo = soloId ? orderedTabs.find((tab) => tab.id === soloId) ?? null : null;
  const visibleTabs = solo ? [solo] : orderedTabs;

  // Rails never apply while a pane is maximized — solo shows exactly one pane.
  const collapsedSet = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const isRail = useCallback(
    (tab: WorkspaceTab) => !solo && collapsedSet.has(tab.id),
    [solo, collapsedSet],
  );
  const expandedVisible = visibleTabs.filter((tab) => !isRail(tab));
  const expandedCount = expandedVisible.length;
  // Only offer "park this pane" when another expanded pane would remain — the
  // last expanded pane can't be parked (nothing would be shown at full size).
  const canCollapse = !solo && expandedCount > 1;

  const fractions = resolveFractions(expandedVisible, activeId, widths);
  // The drag handler pins the current expanded fractions so only the dragged
  // pair moves. Read them from a ref to keep the handler identity stable.
  const fractionsRef = useRef(fractions);
  fractionsRef.current = fractions;

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

      // Pin every expanded pane to its current fraction so only this pair moves.
      const pinned = { ...fractionsRef.current };
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
    [setWidths],
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
    <div className="flex h-[calc(100dvh_-_var(--wc-bar-h,0px))] w-full overflow-x-auto">
      {visibleTabs.map((tab, i) => {
        // A parked tab renders as a narrow rail: a vertical title (with the
        // section icon at the start of the line), click to expand.
        if (isRail(tab)) {
          const path = tab.href.split("?")[0].split("#")[0];
          const RailIcon = navIconFor(stripLocale(path));
          return (
            <div
              key={tab.id}
              role="button"
              tabIndex={0}
              onClick={() => expandTab(tab.id)}
              onKeyDown={(e) => {
                // Only the rail itself expands on Enter/Space — a keydown that
                // bubbled up from the nested close button must not also fire
                // expandTab on the tab being closed.
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  expandTab(tab.id);
                }
              }}
              title={tab.label}
              aria-label={t("expandPaneNamed", { label: tab.label })}
              style={{ flex: `0 0 ${RAIL_PX}px`, width: RAIL_PX }}
              className="group/rail relative flex h-full cursor-pointer flex-col items-stretch border-e bg-muted/30 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            >
              {/* Close — hidden until the rail is hovered (always on touch). */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                aria-label={t("close")}
                title={tab.label ? `${t("close")} · ${tab.label}` : t("close")}
                className="absolute inset-x-0 top-1 z-10 mx-auto inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 opacity-100 transition-opacity hover:bg-accent hover:text-foreground md:opacity-0 md:group-hover/rail:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
              {/* Icon + title rotated 90° clockwise: English reads top-to-bottom,
                  Hebrew bottom-to-top, and the leading icon lands at the start of
                  the line in both (the flex row follows the page direction). */}
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                <div className="flex rotate-90 items-center gap-2 whitespace-nowrap">
                  {RailIcon && <RailIcon className="h-4 w-4 flex-none" />}
                  <span className="select-none text-lg font-medium">{tab.label}</span>
                </div>
              </div>
            </div>
          );
        }

        const active = solo ? true : tab.id === activeId;
        const frac = fractions[tab.id] ?? 1 / Math.max(expandedCount, 1);
        // A divider sits between this pane and the next ONLY when both are
        // expanded panes (rails are fixed-width and share no draggable edge).
        const next = visibleTabs[i + 1];
        const showDivider = !solo && next != null && !isRail(next);
        return (
          <Fragment key={tab.id}>
            <section
              style={{ flexGrow: frac, flexBasis: 0, minWidth: MIN_PANE_PX }}
              className={cn(
                "flex h-full flex-shrink flex-col border-e",
                active ? "bg-background" : "bg-muted/20",
              )}
            >
              {/* No header row — the tab name is dropped (redundant) and closing
                  is a floating X on the pane itself. min-h-0 lets the body scroll
                  internally (iframes are never pushed back). */}
              <div className="relative min-h-0 flex-1">
                <PaneHost tab={tab} />
                {/* Inactive panes are previews: an overlay swallows clicks and
                    focuses the pane instead of interacting with the iframe. */}
                {!active && (
                  <button
                    type="button"
                    onClick={() => setActive(tab.id)}
                    aria-label={t("focusPane")}
                    className="absolute inset-0 z-[60] cursor-pointer bg-transparent"
                  />
                )}
                {/* Collapsed grip in the top-inline-end corner (above the focus
                    overlay at z-70 so it works on inactive panes too). Reserves
                    only its own footprint; hovering/tapping drops the actions
                    down. See PaneControls for the full rationale. */}
                <PaneControls
                  tab={tab}
                  solo={!!solo}
                  canCollapse={canCollapse}
                  onClose={() => closeTab(tab.id)}
                  onCollapse={() => collapseTab(tab.id)}
                  onToggleSolo={() => toggleSolo(tab.id)}
                />
              </div>
            </section>
            {showDivider && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={t("resizePane")}
                onPointerDown={(e) => onHandleDown(e, i, tab, next)}
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
