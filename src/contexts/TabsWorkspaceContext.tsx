"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { stripLocale } from "@/lib/panes/nav";

/**
 * In-app tabs workspace.
 *
 * Clicking a page in the desktop sidebar opens it as a pane inside the content
 * area instead of navigating the whole window. Several panes sit side by side:
 * by default the active pane takes half the available width and the rest share
 * what's left, but the boundaries between panes are draggable so the operator
 * can size each pane (see TabsWorkspace). Open tabs and their widths persist
 * across reloads in localStorage so the operator keeps their working set.
 *
 * A tab's `id` is its full href (locale-prefixed, e.g. "/he/tasks"), so opening
 * the same page twice just focuses the existing pane instead of duplicating it.
 */
export type WorkspaceTab = {
  /** Full href including the locale prefix, e.g. "/he/tasks". Also the id. */
  id: string;
  href: string;
  /** Already-translated label shown on the pane header. */
  label: string;
};

/** Per-tab pane width as a fraction (0..1) of the workspace. Empty means
 *  "use the automatic default" (active pane 50%, the rest share the other
 *  half). Once the user drags a divider, every pane gets an explicit fraction. */
export type PaneWidths = Record<string, number>;

type TabsWorkspaceValue = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  widths: PaneWidths;
  /** True once localStorage has been read. Consumers that react to the tab set
   *  (TabsArea's route adoption) must wait for it — before hydration `tabs` is
   *  always empty and every route would look like "nothing is covering me". */
  hydrated: boolean;
  /** When set, this pane takes the whole workspace and the others are hidden
   *  (not closed). Wide screens — the model-comparison grid is the reason —
   *  are unusable in a half-width pane. */
  soloId: string | null;
  /** Tabs currently parked as narrow "rails": they render as a thin strip that
   *  shows only the title, keeping their content mounted but out of the way.
   *  Opening/focusing a tab parks every OTHER tab here (focus by default);
   *  clicking a rail expands it back beside the others (side-by-side on
   *  demand). The active tab is never in this set — something must always be
   *  shown at full size. */
  collapsedIds: string[];
  /** Maximize this pane, or restore the split view if it is already solo. */
  toggleSolo: (id: string) => void;
  /** Open (or focus, if already open) a page as a pane and make it active.
   *  Every other open tab is parked as a rail so the opened page gets focus. */
  openTab: (href: string, label: string) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** Bring a parked (rail) tab back to full size beside the others and focus
   *  it — WITHOUT parking the rest, so several panes can sit side by side. */
  expandTab: (id: string) => void;
  /** Park an expanded tab back into a rail. No-op on the last expanded pane —
   *  at least one must stay visible. Parking the active pane moves focus to
   *  another expanded pane. */
  collapseTab: (id: string) => void;
  /** Replace the explicit pane-width fractions (used by the drag handles). */
  setWidths: (next: PaneWidths) => void;
  /** Drop all explicit widths and fall back to the automatic layout. */
  resetWidths: () => void;
};

const STORAGE_KEY = "smrtesy.tabs.v1";

const TabsWorkspaceContext = createContext<TabsWorkspaceValue | null>(null);

export function TabsWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [widths, setWidthsState] = useState<PaneWidths>({});
  const [soloId, setSoloId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const router = useRouter();

  // Hydrate from localStorage once, after mount, to avoid an SSR/client
  // markup mismatch (the server has no access to localStorage).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          tabs?: WorkspaceTab[];
          activeId?: string | null;
          widths?: PaneWidths;
          soloId?: string | null;
          collapsedIds?: string[];
        };
        if (Array.isArray(parsed.tabs)) {
          const valid = parsed.tabs.filter(
            (t) => t && typeof t.id === "string" && typeof t.href === "string",
          );
          setTabs(valid);
          const openIds = new Set(valid.map((t) => t.id));
          const stillOpen = valid.some((t) => t.id === parsed.activeId);
          const resolvedActive = stillOpen
            ? parsed.activeId!
            : valid[valid.length - 1]?.id ?? null;
          setActiveId(resolvedActive);
          // Maximized state survives a reload — scoring a panel spans reloads —
          // but only for a tab that is still open.
          if (valid.some((t) => t.id === parsed.soloId)) setSoloId(parsed.soloId!);
          // Parked (rail) tabs survive a reload too. Keep only those still open,
          // and never leave the active tab parked — the active pane must show at
          // full size, so removing it here also guarantees ≥1 expanded pane.
          if (Array.isArray(parsed.collapsedIds)) {
            const collapsed = parsed.collapsedIds.filter(
              (id) => typeof id === "string" && openIds.has(id) && id !== resolvedActive,
            );
            setCollapsedIds(collapsed);
          }
          if (parsed.widths && typeof parsed.widths === "object") {
            // Keep only widths for tabs that are still open.
            const pruned: PaneWidths = {};
            for (const [id, v] of Object.entries(parsed.widths)) {
              if (openIds.has(id) && typeof v === "number" && v > 0) pruned[id] = v;
            }
            setWidthsState(pruned);
          }
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tabs, activeId, widths, soloId, collapsedIds }),
      );
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [tabs, activeId, widths, soloId, collapsedIds, hydrated]);

  const openTab = useCallback((href: string, label: string) => {
    // Dedupe by PAGE (path without query), not by exact href: opening
    // "/he/whatsapp?chat_id=X" while "/he/whatsapp" is already a tab must
    // focus that tab — not open WhatsApp twice. The href update carries the
    // deep link into the open pane (PaneHost watches tab.href).
    const pathOf = (h: string) => h.split("?")[0].split("#")[0].replace(/\/+$/, "");
    const path = pathOf(href);
    setTabs((prev) => {
      // While a pane is maximized, solo FOLLOWS whatever is being opened.
      // Dropping solo instead (what this used to do for a new pane) throws the
      // operator back into the split view they had deliberately left; leaving
      // it alone is worse still — focusing an existing pane while another one
      // is solo used to show nothing at all, since the maximized pane keeps
      // covering the workspace. Either way the page they asked for has to be
      // the one on screen.
      const existing = prev.find((t) => pathOf(t.href) === path);
      if (existing) {
        setActiveId(existing.id);
        setSoloId((cur) => (cur ? existing.id : null));
        // Focus by default: the opened page is the only expanded pane, every
        // other open tab is parked as a rail. Clicking a rail brings it back.
        setCollapsedIds(prev.filter((t) => t.id !== existing.id).map((t) => t.id));
        return href === existing.href
          ? prev
          : prev.map((t) => (t.id === existing.id ? { ...t, href } : t));
      }
      setActiveId(href);
      setSoloId((cur) => (cur ? href : null));
      // Park every previously-open tab; the new pane (href) stays expanded.
      setCollapsedIds(prev.map((t) => t.id));
      // Manual widths are deliberately KEPT. They are keyed by tab id and
      // resolveFractions ignores a partially-explicit set, so the workspace
      // already falls back to the automatic layout while this pane is open —
      // clearing them would only mean the operator's arrangement is gone for
      // good instead of coming back when the pane is closed.
      return [...prev, { id: href, href, label }];
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        // Focus the neighbour that slid into the closed tab's slot — and make
        // sure it is expanded, not still parked as a rail, so something shows.
        const newActive = next[Math.min(idx, next.length - 1)].id;
        setCollapsedIds((cids) => cids.filter((c) => c !== newActive));
        return newActive;
      });
      return next;
    });
    // Drop the closed tab from the rail set regardless of whether it was active.
    setCollapsedIds((prev) => prev.filter((c) => c !== id));
    setWidthsState((prev) => {
      if (!(id in prev)) return prev;
      const rest = { ...prev };
      delete rest[id];
      return rest;
    });
    setSoloId((cur) => (cur === id ? null : cur));
  }, []);

  // Bridge: links inside a pane (an iframe) can't reach this context, so they
  // postMessage up here to open a sibling tab instead of replacing their own
  // iframe (see requestOpenTab). Only the TOP-level provider owns the tab set —
  // the providers that also mount inside panes must ignore these, or the tab
  // would be opened in the wrong (invisible) tree.
  useEffect(() => {
    if (typeof window === "undefined" || window.top !== window.self) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; href?: string; label?: string } | null;
      if (!data || data.type !== "smrtesy:open-tab" || typeof data.href !== "string") return;
      openTab(data.href, typeof data.label === "string" && data.label ? data.label : data.href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openTab]);

  // Bridge: the account screen's language toggle (inside a pane) posts here to
  // switch the whole app's locale IN PLACE (see requestLocaleSwitch). Only the
  // TOP provider handles it. We relocalize the open workspace in React state
  // (swap the /he ↔ /en prefix on every tab id/href, width key, solo/active id
  // and parked-rail id) so iframe panes reload from their new href, then flip
  // the shell locale with a SOFT router navigation — NOT window.location. A
  // document-level navigation makes an installed PWA / in-app browser show its
  // "you left the app" URL bar (× + origin); a client-side route change keeps
  // everything in the same document, so no bar, and next-intl re-renders the
  // shell + component panes in the new locale.
  useEffect(() => {
    if (typeof window === "undefined" || window.top !== window.self) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; locale?: string } | null;
      if (!data || data.type !== "smrtesy:switch-locale") return;
      const loc = data.locale === "en" ? "en" : data.locale === "he" ? "he" : null;
      if (!loc) return;
      // <html lang/dir> lives in the ROOT layout, above the [locale] segment, so
      // a soft navigation never re-renders it — the text would flip to English
      // while the document stayed dir="rtl" (mirrored layout/alignment). Set it
      // imperatively here. Safe without a pane guard: this handler only runs in
      // the top provider (window.top === self above), never inside a pane iframe.
      document.documentElement.lang = loc;
      document.documentElement.dir = loc === "he" ? "rtl" : "ltr";
      const swap = (s: string) => s.replace(/^\/(he|en)(?=\/|$)/, `/${loc}`);
      // Navigate to the active tab's (relocalized) path so TabsArea dedupes onto
      // that pane instead of adopting a stale top-window route as an extra tab.
      // Read the active id from storage (the source of truth) before relocalizing.
      let target: string | null = null;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { activeId?: string | null };
          if (parsed.activeId) target = swap(parsed.activeId);
        }
      } catch {
        /* corrupt storage — fall back to the current path below */
      }
      if (!target) {
        const path = stripLocale(window.location.pathname);
        target = `/${loc}${path === "/" ? "/tasks" : path}`;
      }
      // Relocalize the live workspace state; the persist effect writes it to
      // localStorage. Component panes follow the shell locale (below); iframe
      // panes reload because their tab.href changed.
      setTabs((prev) => prev.map((tab) => ({ ...tab, id: swap(tab.id), href: swap(tab.href) })));
      setActiveId((cur) => (cur ? swap(cur) : cur));
      setSoloId((cur) => (cur ? swap(cur) : cur));
      setCollapsedIds((prev) => prev.map(swap));
      setWidthsState((prev) =>
        Object.fromEntries(Object.entries(prev).map(([k, v]) => [swap(k), v])),
      );
      router.push(target);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  const setActive = useCallback((id: string) => setActiveId(id), []);
  const setWidths = useCallback((next: PaneWidths) => setWidthsState(next), []);
  const resetWidths = useCallback(() => setWidthsState({}), []);
  const toggleSolo = useCallback((id: string) => {
    setSoloId((cur) => (cur === id ? null : id));
    setActiveId(id);
  }, []);

  // Bring a rail back to full size beside the others (additive — the rest stay
  // as they are) and focus it. This is what makes side-by-side possible again
  // after the focus-on-open parking.
  const expandTab = useCallback((id: string) => {
    setCollapsedIds((prev) => prev.filter((c) => c !== id));
    setActiveId(id);
  }, []);

  // Park an expanded pane back into a rail. Guarded so the last expanded pane
  // can never be parked (the workspace would show nothing at full size), and
  // parking the active pane hands focus to another expanded one.
  const collapseTab = useCallback(
    (id: string) => {
      if (collapsedIds.includes(id)) return;
      const expandedRemaining = tabs.filter(
        (t) => t.id !== id && !collapsedIds.includes(t.id),
      );
      if (expandedRemaining.length === 0) return;
      setCollapsedIds([...collapsedIds, id]);
      if (activeId === id) setActiveId(expandedRemaining[0].id);
    },
    [tabs, collapsedIds, activeId],
  );

  return (
    <TabsWorkspaceContext.Provider
      value={{
        tabs,
        activeId,
        widths,
        soloId,
        collapsedIds,
        hydrated,
        openTab,
        closeTab,
        setActive,
        expandTab,
        collapseTab,
        setWidths,
        resetWidths,
        toggleSolo,
      }}
    >
      {children}
    </TabsWorkspaceContext.Provider>
  );
}

export function useTabsWorkspace() {
  const ctx = useContext(TabsWorkspaceContext);
  if (!ctx) {
    throw new Error("useTabsWorkspace must be used within a TabsWorkspaceProvider");
  }
  return ctx;
}

/** Like useTabsWorkspace but returns null instead of throwing when there is no
 *  provider — for chrome that may render outside the workspace (e.g. on mobile
 *  or login screens). */
export function useOptionalTabsWorkspace() {
  return useContext(TabsWorkspaceContext);
}
