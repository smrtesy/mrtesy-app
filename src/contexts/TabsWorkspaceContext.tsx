"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
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
  /** Maximize this pane, or restore the split view if it is already solo. */
  toggleSolo: (id: string) => void;
  /** Open (or focus, if already open) a page as a pane and make it active. */
  openTab: (href: string, label: string) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
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
  const [hydrated, setHydrated] = useState(false);

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
        };
        if (Array.isArray(parsed.tabs)) {
          const valid = parsed.tabs.filter(
            (t) => t && typeof t.id === "string" && typeof t.href === "string",
          );
          setTabs(valid);
          const stillOpen = valid.some((t) => t.id === parsed.activeId);
          setActiveId(stillOpen ? parsed.activeId! : valid[valid.length - 1]?.id ?? null);
          // Maximized state survives a reload — scoring a panel spans reloads —
          // but only for a tab that is still open.
          if (valid.some((t) => t.id === parsed.soloId)) setSoloId(parsed.soloId!);
          if (parsed.widths && typeof parsed.widths === "object") {
            // Keep only widths for tabs that are still open.
            const openIds = new Set(valid.map((t) => t.id));
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
        JSON.stringify({ tabs, activeId, widths, soloId }),
      );
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [tabs, activeId, widths, soloId, hydrated]);

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
        return href === existing.href
          ? prev
          : prev.map((t) => (t.id === existing.id ? { ...t, href } : t));
      }
      setActiveId(href);
      setSoloId((cur) => (cur ? href : null));
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
        // Focus the neighbour that slid into the closed tab's slot.
        return next[Math.min(idx, next.length - 1)].id;
      });
      return next;
    });
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
  // TOP provider handles it — from the top context the reload is a first-party
  // navigation that stays inside an installed PWA. We relocalize the PERSISTED
  // workspace (swap the /he ↔ /en prefix on every tab id/href, the width keys,
  // solo and active ids) so the tabs reopen in the new locale instead of a
  // stale mix, then reload the shell on the same screen. Reading/writing
  // localStorage directly (not React state) keeps this race-free right before
  // the reload.
  useEffect(() => {
    if (typeof window === "undefined" || window.top !== window.self) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; locale?: string } | null;
      if (!data || data.type !== "smrtesy:switch-locale") return;
      const loc = data.locale === "en" ? "en" : data.locale === "he" ? "he" : null;
      if (!loc) return;
      const swap = (s: string) => s.replace(/^\/(he|en)(?=\/|$)/, `/${loc}`);
      // Reload the shell on the screen the operator is actually looking at (the
      // active tab), so it dedupes onto an existing pane rather than adopting a
      // stale top-window path as an extra tab. Falls back to the current path.
      let reloadTarget: string | null = null;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            tabs?: WorkspaceTab[];
            activeId?: string | null;
            widths?: PaneWidths;
            soloId?: string | null;
          };
          const next = {
            tabs: Array.isArray(parsed.tabs)
              ? parsed.tabs.map((t) => ({ ...t, id: swap(t.id), href: swap(t.href) }))
              : [],
            activeId: parsed.activeId ? swap(parsed.activeId) : null,
            widths:
              parsed.widths && typeof parsed.widths === "object"
                ? Object.fromEntries(
                    Object.entries(parsed.widths).map(([k, v]) => [swap(k), v]),
                  )
                : {},
            soloId: parsed.soloId ? swap(parsed.soloId) : null,
          };
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
          reloadTarget = next.activeId;
        }
      } catch {
        /* corrupt storage — the reload below still switches the shell locale */
      }
      if (!reloadTarget) {
        const path = stripLocale(window.location.pathname);
        reloadTarget = `/${loc}${path === "/" ? "/tasks" : path}`;
      }
      window.location.assign(reloadTarget);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const setActive = useCallback((id: string) => setActiveId(id), []);
  const setWidths = useCallback((next: PaneWidths) => setWidthsState(next), []);
  const resetWidths = useCallback(() => setWidthsState({}), []);
  const toggleSolo = useCallback((id: string) => {
    setSoloId((cur) => (cur === id ? null : id));
    setActiveId(id);
  }, []);

  return (
    <TabsWorkspaceContext.Provider
      value={{
        tabs,
        activeId,
        widths,
        soloId,
        hydrated,
        openTab,
        closeTab,
        setActive,
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
