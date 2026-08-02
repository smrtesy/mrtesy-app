"use client";

/**
 * Global open/close state for the floating Claude console side-drawer.
 *
 * The drawer is a compact, dismissible side chat that hosts the /claude console
 * (see ClaudeDrawer.tsx). It has NO launcher of its own — it is opened from the
 * console entry points the app already has (the sidebar "קלוד" button on
 * desktop, the Claude FAB on mobile), so we don't add a second button for the
 * same thing. Those entry points call toggleDrawer(); the drawer renders itself.
 *
 * Consumers:
 *   <ClaudeDrawer>  — renders the drawer, reads `open`, calls closeDrawer()
 *   Sidebar.tsx     — the existing Claude button/FAB call toggleDrawer()
 *
 * Provided unconditionally (Sidebar renders for every user and calls the hook
 * at top level); the drawer component itself stays admin-gated in the layout.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const OPEN_KEY = "claude-drawer-open";

interface ClaudeDrawerValue {
  open: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
}

const Ctx = createContext<ClaudeDrawerValue | null>(null);

export function ClaudeDrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // Restore the persisted state on mount (client only, so server and first
  // client render agree on `false` — no hydration mismatch).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
    } catch {
      /* localStorage unavailable (private mode) — stay closed */
    }
  }, []);

  const persist = useCallback((next: boolean) => {
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  const openDrawer = useCallback(() => {
    setOpen(true);
    persist(true);
  }, [persist]);
  const closeDrawer = useCallback(() => {
    setOpen(false);
    persist(false);
  }, [persist]);
  const toggleDrawer = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      persist(next);
      return next;
    });
  }, [persist]);

  const value = useMemo(
    () => ({ open, openDrawer, closeDrawer, toggleDrawer }),
    [open, openDrawer, closeDrawer, toggleDrawer],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Safe outside a provider: returns an inert value rather than throwing, so a
 * Sidebar rendered in some future context without the provider degrades to "the
 * button does nothing" instead of crashing the app.
 */
export function useClaudeDrawer(): ClaudeDrawerValue {
  return (
    useContext(Ctx) ?? {
      open: false,
      openDrawer: () => {},
      closeDrawer: () => {},
      toggleDrawer: () => {},
    }
  );
}
