"use client";

import { useCallback } from "react";
import Link from "next/link";
import { isEmbeddedPane, requestOpenTab } from "@/lib/navigate";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { useOptionalPaneNav } from "@/lib/panes/nav";

/**
 * Imperative twin of OpenTabLink — for when the target is only known after an
 * async step (e.g. create a Claude thread, THEN open it). Same three cases:
 * component pane → open a sibling tab; legacy iframe pane → bridge to the top
 * window; outside a pane → navigate. Never opens a new BROWSER window.
 */
export function useOpenTab(): (href: string, label: string) => void {
  const tabs = useOptionalTabsWorkspace();
  const paneNav = useOptionalPaneNav();
  return useCallback(
    (href: string, label: string) => {
      if (paneNav && tabs) {
        tabs.openTab(href, label);
        return;
      }
      if (isEmbeddedPane()) {
        requestOpenTab(href, label);
        return;
      }
      window.location.href = href;
    },
    [tabs, paneNav],
  );
}

/**
 * A link that opens its target as a NEW tabs-workspace pane when clicked from
 * INSIDE a pane, instead of navigating (replacing) the current pane's iframe.
 *
 * Covers both pane generations: a component pane reaches the workspace context
 * directly (same React tree); a legacy iframe pane posts a message to the top
 * window. Outside a pane it's a plain <Link> — so on mobile, or on a full page
 * with no workspace open, it just navigates normally. This keeps in-page jumps (e.g. the
 * "open log" shortcut next to a page title) consistent with the sidebar, which
 * always opens a tab rather than swapping the pane you're looking at.
 */
export function OpenTabLink({
  href,
  label,
  className,
  title,
  beside,
  "aria-label": ariaLabel,
  children,
}: {
  /** Locale-prefixed href, e.g. `/he/log`. Also the tab id (dedup key). */
  href: string;
  /** Pane-header label for the opened tab. */
  label: string;
  className?: string;
  title?: string;
  /**
   * Open the target BESIDE the current pane instead of focusing it: the pane
   * this link lives in stays expanded rather than being parked as a rail
   * (openTab's `{ focus: false }`). For screens that remain useful after the
   * click — the site map, a list you keep picking from.
   */
  beside?: boolean;
  "aria-label"?: string;
  children: React.ReactNode;
}) {
  const tabs = useOptionalTabsWorkspace();
  const paneNav = useOptionalPaneNav();

  return (
    <Link
      href={href}
      title={title}
      aria-label={ariaLabel}
      className={className}
      onClick={(e) => {
        // Component pane — same tree, open the sibling tab directly.
        if (paneNav && tabs) {
          e.preventDefault();
          tabs.openTab(href, label, beside ? { focus: false } : undefined);
          return;
        }
        // Legacy iframe pane — bridge to the top window.
        if (isEmbeddedPane()) {
          e.preventDefault();
          requestOpenTab(href, label, beside);
        }
      }}
    >
      {children}
    </Link>
  );
}
