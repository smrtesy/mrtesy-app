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
import Link from "next/link";
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

/** Split an href into the pane-location shape. Splits on the FIRST "?" (a
 *  query value may itself contain "?") and drops any "#fragment". */
export function parsePaneHref(href: string): PaneLocation {
  const noHash = href.split("#")[0];
  const q = noHash.indexOf("?");
  const pathname = q === -1 ? noHash : noHash.slice(0, q);
  const search = q === -1 ? "" : noHash.slice(q + 1);
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

type ScreenNavOptions = { scroll?: boolean };

// NOTE for consumers: inside a pane the returned router's identity changes on
// every pane navigation (the context value tracks the location). Effects that
// depend on it re-run per navigation — guard one-shot effects with a ref or a
// storage marker (see MorningInboxRedirect / TaskList's focusedRef).

export function useScreenRouter(): {
  push: (href: string, opts?: ScreenNavOptions) => void;
  replace: (href: string, opts?: ScreenNavOptions) => void;
} {
  const pane = useContext(PaneNavContext);
  const router = useRouter();
  return useMemo(
    () =>
      pane
        ? // Pane content swaps don't scroll the window — the option is moot.
          { push: (href: string) => pane.push(href), replace: (href: string) => pane.replace(href) }
        : {
            push: (href: string, opts?: ScreenNavOptions) => router.push(href, opts),
            replace: (href: string, opts?: ScreenNavOptions) => router.replace(href, opts),
          },
    [pane, router],
  );
}

/**
 * Drop-in replacement for next/link inside screens that can render in a pane.
 * As a routed page it IS next/link (prefetch and all); inside a pane a plain
 * navigation would swap the TOP route underneath the workspace — invisible
 * and confusing — so instead the click swaps this pane's content (falling
 * back to an iframe when the target isn't in the registry). Modified clicks
 * (new-tab, middle-click) keep native anchor behavior.
 */
export function PaneLink(props: React.ComponentProps<typeof Link>) {
  const pane = useContext(PaneNavContext);
  // String hrefs only — the object form keeps just `pathname` (no callers
  // pass query/hash objects; pass a string if you need them).
  const rawHref = props.href;
  const target = typeof rawHref === "string" ? rawHref : (rawHref.pathname ?? "/");
  // External URLs (https://mail.google.com/…, mailto:, tel:) must never be
  // pushed into a pane — they'd become a broken iframe. From a pane, open
  // them in a new browser tab; elsewhere Link handles them as a full nav.
  const isExternal = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(target);

  if (!pane) return <Link {...props} />;

  // Strip Link-only props (href/prefetch/scroll) so they don't land on the <a>.
  const { replace, onClick, ...rest } = props;
  delete (rest as Record<string, unknown>).href;
  delete (rest as Record<string, unknown>).prefetch;
  delete (rest as Record<string, unknown>).scroll;

  if (isExternal) {
    return <a {...rest} href={target} target="_blank" rel="noopener noreferrer" onClick={onClick} />;
  }
  return (
    <a
      {...rest}
      href={target}
      onClick={(e) => {
        onClick?.(e as React.MouseEvent<HTMLAnchorElement>);
        if (e.defaultPrevented) return;
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        (replace ? pane.replace : pane.push)(target);
      }}
    />
  );
}
