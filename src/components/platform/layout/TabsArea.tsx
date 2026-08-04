"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { isEmbeddedPane } from "@/lib/navigate";
import { stripLocale } from "@/lib/panes/nav";
import { fallbackRouteLabel, navLabelKeyFor } from "@/lib/panes/route-label";
import { TabsWorkspace } from "./TabsWorkspace";

/** True when this document arrived from an explicit navigation (address bar,
 *  a link from outside, a bookmark, back/forward) rather than a reload.
 *
 *  A reload re-enters the workspace exactly where it was: the URL is whatever
 *  the last real navigation left behind, which with panes open is usually
 *  stale, so it must NOT be treated as "the operator asked for this page".
 *  Anything else is a deliberate request for that URL. Unknown/unsupported →
 *  false, i.e. behave like today rather than opening panes nobody asked for. */
function arrivedByNavigation(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type === "navigate" || entry?.type === "back_forward";
  } catch {
    return false;
  }
}

/**
 * Bridges the server-rendered page (`children`) and the in-app tabs workspace.
 *
 * - No open tabs (or on mobile): render the current route normally, in the
 *   centered content container.
 * - Desktop with open tabs: hand the content area over to the side-by-side
 *   panes. The sidebar links open tabs instead of navigating, so the page
 *   URL stays put while the panes drive what's shown.
 *
 * Because the panes REPLACE `children`, a route reached by an actual browser
 * navigation — a pasted deep link, a link from outside the app, an OAuth
 * return, the back button, a `router.push` from code that isn't pane-aware —
 * used to render into a subtree nothing ever displayed: the URL changed, the
 * page mounted, and the operator kept staring at the panes until they closed
 * every tab. So any navigation the panes would hide is ADOPTED into the
 * workspace as a pane of its own (see the effect below). Landing on a page
 * that is already open just focuses that pane — and carries the deep link's
 * query into it, because openTab dedupes by page rather than by exact href.
 */
export function TabsArea({ children }: { children: React.ReactNode }) {
  const { tabs, hydrated, openTab } = useTabsWorkspace();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations("nav");
  // Start true so SSR and the first client render agree (the panes only ever
  // populate from desktop sidebar clicks); correct to the real value on mount.
  const [isDesktop, setIsDesktop] = useState(true);
  // The optimistic `true` above must not drive route adoption — on a phone it
  // would add a pane nobody can see. Adoption waits for the real measurement.
  const [mqReady, setMqReady] = useState(false);
  // A pane's iframe loads this very layout. localStorage is origin-global, so
  // the pane would hydrate the same open tabs and render its OWN workspace —
  // recursing panes-within-panes. When embedded, always show the plain page.
  const [isEmbedded] = useState(() => isEmbeddedPane());

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => {
      setIsDesktop(mq.matches);
      setMqReady(true);
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const search = searchParams.toString();
  const href = search ? `${pathname}?${search}` : pathname;

  // The route this component has already accounted for, and whether the
  // page-load pass has run. Refs, not state: they must not themselves trigger
  // the effect, or opening a pane from the sidebar (which changes tabs.length,
  // never the URL) would re-run the load pass and adopt the background route.
  const settledHrefRef = useRef<string | null>(null);
  const didLoadPassRef = useRef(false);

  useEffect(() => {
    if (isEmbedded || !mqReady || !isDesktop || !hydrated) return;

    const adopt = () => {
      const path = stripLocale(pathname);
      const key = navLabelKeyFor(path);
      openTab(href, key ? t(key as Parameters<typeof t>[0]) : fallbackRouteLabel(path));
    };

    if (!didLoadPassRef.current) {
      // First pass after hydration — decide about the URL the document loaded
      // at. A deliberate navigation (deep link, OAuth return, back button) is
      // adopted so it shows as a pane; the desktop workspace no longer renders
      // the bare route, so without this an operator with zero open tabs would
      // land on a blank board. A plain reload (not a navigation) is NOT adopted,
      // which is what lets "close every tab" stay an empty board across reloads.
      didLoadPassRef.current = true;
      settledHrefRef.current = href;
      if (arrivedByNavigation()) adopt();
      return;
    }

    // In-session navigation. Panes never change the URL, so a changed URL here
    // is a real navigation — and with panes open it lands out of sight.
    const settled = settledHrefRef.current;
    if (href === settled) return;
    settledHrefRef.current = href;

    // …with one exception. The routed page still mounts and runs its effects
    // for the commit before hydration swaps it for the panes, and the OAuth
    // return screens use exactly that commit to strip their result param from
    // the URL (ReachSettingsClient.tsx:66, AccountClient.tsx:53 —
    // router.replace to the bare path). That lands here as a URL change; if we
    // adopted it, openTab would dedupe onto the pane just created and rewrite
    // its href back to the bare path, reloading the pane WITHOUT the deep link
    // the operator followed. Same path with the query gone is cleanup, not a
    // navigation.
    if (!search && settled !== null && settled.split("?")[0] === pathname) return;

    adopt();
  }, [href, pathname, search, tabs.length, hydrated, mqReady, isDesktop, isEmbedded, openTab, t]);

  // Desktop, viewport measured and storage read: the workspace owns the content
  // area. With tabs open, render the panes; with none open, render a quiet empty
  // board (the sidebar stays) — the operator can close everything and nothing is
  // force-opened by default. Before that (SSR, first paint, mobile, panes) the
  // plain routed page renders as before.
  if (!isEmbedded && isDesktop && mqReady && hydrated) {
    if (tabs.length > 0) return <TabsWorkspace />;
    return <EmptyWorkspace />;
  }

  // Embedded (the Claude drawer's iframe): host the screen at a BOUNDED full height,
  // no max-width and no padding. A full-height chat (`h-full`, its own scroll +
  // pinned composer) needs a height-bounded ancestor; the plain centered wrapper
  // below has auto height, so the chat grew with each streamed message and pushed
  // the composer below the fold — hiding what the user was typing. 100dvh here is
  // the iframe's own viewport, so it fills the drawer exactly. The centered wrapper
  // stays for the mobile / SSR fallback (regular scrolling pages).
  if (isEmbedded) {
    return <div className="h-[100dvh] w-full overflow-hidden">{children}</div>;
  }

  return <div className="w-full max-w-4xl mx-auto p-4 md:p-6">{children}</div>;
}

/** Shown on desktop when every tab is closed: sidebar + a blank board. */
function EmptyWorkspace() {
  const t = useTranslations("tabsWorkspace");
  return (
    <div className="flex h-[calc(100dvh_-_var(--wc-bar-h,0px))] w-full flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-sm font-medium text-muted-foreground">{t("emptyTitle")}</p>
      <p className="text-xs text-muted-foreground/70">{t("emptyHint")}</p>
    </div>
  );
}
