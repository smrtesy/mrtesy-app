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

import { Component, useCallback, useMemo, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { WorkspaceTab } from "@/contexts/TabsWorkspaceContext";
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
 *  this isolation for free, the boundary restores it for component panes. */
class PaneErrorBoundary extends Component<
  { fallback: (reset: () => void) => ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
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
  const [location, setLocation] = useState<PaneLocation>(() => parsePaneHref(tab.href));

  const push = useCallback((href: string) => setLocation(parsePaneHref(href)), []);
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
        <PaneErrorBoundary
          key={`${location.pathname}?${location.search}`}
          fallback={(reset) => <PaneError reset={reset} />}
        >
          {/* Mirrors the embedded-page container: TabsArea's p-4/md:p-6 with
              the max-width lifted by the data-embed CSS. */}
          <div className="w-full p-4 md:p-6">{screen.render(locale)}</div>
        </PaneErrorBoundary>
      </PaneNavProvider>
    </div>
  );
}
