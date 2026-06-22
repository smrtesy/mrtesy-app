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
 * the active pane takes half the available width and the rest share what's
 * left (see TabsWorkspace). Open tabs persist across reloads in localStorage so
 * the operator keeps their working set.
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

type TabsWorkspaceValue = {
  tabs: WorkspaceTab[];
  activeId: string | null;
  /** Open (or focus, if already open) a page as a pane and make it active. */
  openTab: (href: string, label: string) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
};

const STORAGE_KEY = "smrtesy.tabs.v1";

const TabsWorkspaceContext = createContext<TabsWorkspaceValue | null>(null);

export function TabsWorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage once, after mount, to avoid an SSR/client
  // markup mismatch (the server has no access to localStorage).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { tabs?: WorkspaceTab[]; activeId?: string | null };
        if (Array.isArray(parsed.tabs)) {
          const valid = parsed.tabs.filter(
            (t) => t && typeof t.id === "string" && typeof t.href === "string",
          );
          setTabs(valid);
          const stillOpen = valid.some((t) => t.id === parsed.activeId);
          setActiveId(stillOpen ? parsed.activeId! : valid[valid.length - 1]?.id ?? null);
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
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs, activeId }));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [tabs, activeId, hydrated]);

  const openTab = useCallback((href: string, label: string) => {
    setTabs((prev) =>
      prev.some((t) => t.id === href) ? prev : [...prev, { id: href, href, label }],
    );
    setActiveId(href);
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
  }, []);

  const setActive = useCallback((id: string) => setActiveId(id), []);

  return (
    <TabsWorkspaceContext.Provider value={{ tabs, activeId, openTab, closeTab, setActive }}>
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
