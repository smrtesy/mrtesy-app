"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useTabsWorkspace } from "@/contexts/TabsWorkspaceContext";

/** Append the embed flag so the page renders without the app chrome (sidebar,
 *  floating panels) inside the pane — see globals.css `html[data-embed="1"]`. */
function withEmbed(href: string): string {
  return href + (href.includes("?") ? "&" : "?") + "embed=1";
}

/**
 * Side-by-side panes for the open sidebar tabs (desktop only). The active pane
 * takes half the width; the rest share the other half and act as previews —
 * clicking one focuses it (making it the active half-width pane). A single open
 * tab fills the whole area.
 */
export function TabsWorkspace() {
  const { tabs, activeId, setActive, closeTab } = useTabsWorkspace();
  const t = useTranslations("tabsWorkspace");
  const n = tabs.length;

  return (
    <div className="flex h-[100dvh] w-full overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const width = n <= 1 ? "100%" : active ? "50%" : `${50 / (n - 1)}%`;
        return (
          <section
            key={tab.id}
            style={{ width }}
            className={cn(
              "flex h-full min-w-[160px] flex-[0_0_auto] flex-col border-e",
              active ? "bg-background" : "bg-muted/20",
            )}
          >
            <header
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 border-b px-2",
                active ? "bg-muted/40" : "bg-muted/60",
              )}
            >
              <button
                type="button"
                onClick={() => setActive(tab.id)}
                className="flex-1 truncate text-start text-xs font-medium text-foreground/90"
                title={tab.label}
              >
                {tab.label}
              </button>
              <button
                type="button"
                onClick={() => closeTab(tab.id)}
                aria-label={t("close")}
                title={t("close")}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </header>
            <div className="relative flex-1">
              <iframe
                src={withEmbed(tab.href)}
                title={tab.label}
                className="h-full w-full border-0"
              />
              {/* Inactive panes are previews: an overlay swallows clicks and
                  focuses the pane instead of interacting with the iframe. */}
              {!active && (
                <button
                  type="button"
                  onClick={() => setActive(tab.id)}
                  aria-label={t("focusPane")}
                  className="absolute inset-0 cursor-pointer bg-transparent"
                />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
