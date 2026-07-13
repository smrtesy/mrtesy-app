"use client";

/**
 * Pane-local navigation for the tabs workspace (docs/router-panes-plan.md §4.3).
 *
 * A component-rendered pane is NOT at its own URL — the browser URL belongs to
 * the top window and is decoupled from what panes show. Screens that read or
 * write the URL (search params, pathname, router.push/replace) use the
 * `useScreen*` hooks below instead of next/navigation directly:
 *
 *   - rendered as a normal routed page (mobile, no tabs open, or a screen not
 *     yet migrated) there is no PaneNav context and the hooks are exactly
 *     next/navigation;
 *   - rendered inside a pane they read/write the pane's own location state.
 *
 * `pathname` keeps the locale prefix (e.g. "/he/tasks"), matching what
 * next/navigation's usePathname returns, so consumers behave identically in
 * both modes.
 */

import { createContext, useContext, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type PaneLocation = {
  /** Locale-prefixed pathname, e.g. "/he/plan/team". */
  pathname: string;
  /** Raw query string without the leading "?" (may be ""). */
  search: string;
};

export type PaneNavValue = {
  location: PaneLocation;
  /** Swap this pane's content to `href` (locale-prefixed, may carry a query). */
  push: (href: string) => void;
  replace: (href: string) => void;
};

const PaneNavContext = createContext<PaneNavValue | null>(null);

/** Split an href into the pane-location shape. */
export function parsePaneHref(href: string): PaneLocation {
  const [pathname, search = ""] = href.split("?");
  return { pathname: pathname.replace(/\/+$/, "") || "/", search };
}

/** "/he/plan/team" → "/plan/team" (registry matching is locale-agnostic). */
export function stripLocale(pathname: string): string {
  const segs = pathname.split("/").filter(Boolean);
  if (segs[0] === "he" || segs[0] === "en") segs.shift();
  return "/" + segs.join("/");
}

export function PaneNavProvider({
  value,
  children,
}: {
  value: PaneNavValue;
  children: React.ReactNode;
}) {
  return <PaneNavContext.Provider value={value}>{children}</PaneNavContext.Provider>;
}

/** Null outside a pane — chrome/screens can branch on "am I in a pane?". */
export function useOptionalPaneNav(): PaneNavValue | null {
  return useContext(PaneNavContext);
}

// ── drop-in replacements for next/navigation inside screens ────────────────
// All three call the Next hooks unconditionally (rules of hooks) and prefer
// the pane values when a pane context exists.

export function useScreenPathname(): string {
  const pane = useContext(PaneNavContext);
  const routed = usePathname();
  return pane ? pane.location.pathname : routed;
}

export function useScreenSearchParams(): URLSearchParams {
  const pane = useContext(PaneNavContext);
  const routed = useSearchParams();
  // `pane` is re-memoized by PaneHost whenever its location changes, so the
  // object identity alone is a sufficient dependency.
  return useMemo(
    () => (pane ? new URLSearchParams(pane.location.search) : new URLSearchParams(routed.toString())),
    [pane, routed],
  );
}

export function useScreenRouter(): { push: (href: string) => void; replace: (href: string) => void } {
  const pane = useContext(PaneNavContext);
  const router = useRouter();
  return useMemo(
    () =>
      pane
        ? { push: pane.push, replace: pane.replace }
        : { push: (href: string) => router.push(href), replace: (href: string) => router.replace(href) },
    [pane, router],
  );
}
