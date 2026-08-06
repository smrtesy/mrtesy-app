"use client";

/**
 * PaneHost — the body of a single tabs-workspace pane
 * (docs/router-panes-plan.md §4.2).
 *
 * Screens registered in src/lib/panes/registry.tsx render directly as
 * components: instant open, shared React tree (one QueryClient, one realtime
 * set). Everything else keeps the legacy full-document iframe, so unmigrated
 * routes are untouched. In-pane navigation (useScreenRouter().push) swaps
 * this pane's location; if the target isn't registered the pane simply
 * becomes an iframe at that href.
 */

import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { FeatureIdContext } from "@/components/platform/features/FeatureIdContext";
import { reportFeatureCrash } from "@/lib/error-capture";
import { useTabsWorkspace, type WorkspaceTab } from "@/contexts/TabsWorkspaceContext";
import {
  PaneNavProvider,
  parsePaneHref,
  stripLocale,
  type PaneLocation,
  type PaneNavValue,
} from "@/lib/panes/nav";
import { resolvePaneScreen } from "@/lib/panes/registry";

/** Panes get ?embed=1 so the framed document strips its chrome on first
 *  paint, before the window.self !== window.top check can run. */
function withEmbed(href: string): string {
  return href.includes("?") ? `${href}&embed=1` : `${href}?embed=1`;
}

/** One crashing screen must not take down the whole workspace — iframes gave
 *  this isolation for free, the boundary restores it for component panes.
 *
 *  Source 1 of the feature log (docs/feature-channels-plan.md §8): the crash is
 *  still swallowed and the fallback still shown (getDerivedStateFromError), and
 *  componentDidCatch additionally records a category='feature' row. The feature
 *  id comes from FeatureIdContext when the boundary sits inside a <FeatureGate>
 *  (static contextType — a class can't use the hook), else the screen key from
 *  the path is the tag. */
class PaneErrorBoundary extends Component<
  { fallback: (reset: () => void) => ReactNode; screenKey: string; children: ReactNode },
  { failed: boolean }
> {
  static contextType = FeatureIdContext;
  declare context: string | null;

  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportFeatureCrash({
      featureId: this.context ?? null,
      screenKey: this.props.screenKey,
      message: error?.message || String(error),
      stack: error?.stack ?? info?.componentStack ?? undefined,
      url: typeof window !== "undefined" ? window.location.href : this.props.screenKey,
    });
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback(() => this.setState({ failed: false }));
    }
    return this.props.children;
  }
}

function PaneError({ reset }: { reset: () => void }) {
  const t = useTranslations("tabsWorkspace");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("paneError")}</p>
      <Button variant="outline" size="sm" onClick={reset}>
        {t("paneReload")}
      </Button>
    </div>
  );
}

export function PaneHost({ tab }: { tab: WorkspaceTab }) {
  const locale = useLocale();
  const { setTabLoc } = useTabsWorkspace();
  // The pane opens at its drilled-into position (`loc`) if one survived a
  // reload, otherwise at the tab's base href.
  const [location, setLocation] = useState<PaneLocation>(() =>
    parsePaneHref(tab.loc ?? tab.href),
  );

  // Keep the live location in sync with the persisted tab: openTab carrying a
  // deep link updates tab.href (and clears loc); a restored/normalized loc
  // updates tab.loc. Either way the pane follows.
  useEffect(() => {
    setLocation(parsePaneHref(tab.loc ?? tab.href));
  }, [tab.href, tab.loc]);

  // Internal pane navigation (PaneLink / useScreenRouter) swaps the pane's
  // location AND records it on the tab so it survives a reload. tab.id is the
  // stable identity — never the drilled href — so dedupe/labels are untouched.
  const push = useCallback(
    (href: string) => {
      setLocation(parsePaneHref(href));
      setTabLoc(tab.id, href);
    },
    [setTabLoc, tab.id],
  );
  const nav = useMemo<PaneNavValue>(
    () => ({ location, push, replace: push }),
    [location, push],
  );

  const screen = resolvePaneScreen(stripLocale(location.pathname));

  if (!screen) {
    const href = location.search ? `${location.pathname}?${location.search}` : location.pathname;
    return <iframe src={withEmbed(href)} title={tab.label} className="h-full w-full border-0" />;
  }

  return (
    <div className="h-full w-full overflow-y-auto bg-background">
      <PaneNavProvider value={nav}>
        {/* Keyed by pathname ONLY: search-param changes (?focus strip, ?draft
            strip) must update in place — remounting would drop screen state.
            A different screen in the same pane still gets a fresh boundary. */}
        <PaneErrorBoundary
          key={location.pathname}
          screenKey={stripLocale(location.pathname)}
          fallback={(reset) => <PaneError reset={reset} />}
        >
          {screen.fullHeight ? (
            // Chat-style screens: definite height so their h-full resolves,
            // internal scroll is theirs.
            <div className="h-full w-full">{screen.render(locale)}</div>
          ) : (
            // Mirrors the embedded-page container: TabsArea's p-4/md:p-6 with
            // the max-width lifted by the data-embed CSS.
            <div className="w-full p-4 md:p-6">{screen.render(locale)}</div>
          )}
        </PaneErrorBoundary>
      </PaneNavProvider>
    </div>
  );
}
