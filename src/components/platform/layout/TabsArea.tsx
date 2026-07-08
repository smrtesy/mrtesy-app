"use client";

import { useEffect, useState } from "react";
import { useTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { isEmbeddedPane } from "@/lib/navigate";
import { TabsWorkspace } from "./TabsWorkspace";

/**
 * Bridges the server-rendered page (`children`) and the in-app tabs workspace.
 *
 * - No open tabs (or on mobile): render the current route normally, in the
 *   centered content container.
 * - Desktop with open tabs: hand the content area over to the side-by-side
 *   panes. The sidebar links open tabs instead of navigating, so the page
 *   URL stays put while the panes drive what's shown.
 */
export function TabsArea({ children }: { children: React.ReactNode }) {
  const { tabs } = useTabsWorkspace();
  // Start true so SSR and the first client render agree (the panes only ever
  // populate from desktop sidebar clicks); correct to the real value on mount.
  const [isDesktop, setIsDesktop] = useState(true);
  // A pane's iframe loads this very layout. localStorage is origin-global, so
  // the pane would hydrate the same open tabs and render its OWN workspace —
  // recursing panes-within-panes. When embedded, always show the plain page.
  const [isEmbedded] = useState(() => isEmbeddedPane());

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (!isEmbedded && isDesktop && tabs.length > 0) {
    return <TabsWorkspace />;
  }

  return <div className="w-full max-w-4xl mx-auto p-4 md:p-6">{children}</div>;
}
