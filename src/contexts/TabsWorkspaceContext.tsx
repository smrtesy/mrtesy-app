"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

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
        };
        if (Array.isArray(parsed.tabs)) {
          const valid = parsed.tabs.filter(
            (t) => t && typeof t.id === "string" && typeof t.href === "string",
          );
          setTabs(valid);
          const stillOpen = valid.some((t) => t.id === parsed.activeId);
          setActiveId(stillOpen ? parsed.activeId! : valid[valid.length - 1]?.id ?? null);
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
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId, widths }));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [tabs, activeId, widths, hydrated]);

  const openTab = useCallback((href: string, label: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === href) ? prev : [...prev, { id: href, href, label }],
    );
    setActiveId(href);
    // A new pane changes the layout — drop manual widths so the set re-lays out
    // with the automatic default; the user can re-drag from there.
    setWidthsState({});
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
  }, []);

  const setActive = useCallback((id: string) => setActiveId(id), []);
  const setWidths = useCallback((next: PaneWidths) => setWidthsState(next), []);
  const resetWidths = useCallback(() => setWidthsState({}), []);

  return (
    <TabsWorkspaceContext.Provider
      value={{ tabs, activeId, widths, openTab, closeTab, setActive, setWidths, resetWidths }}
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
