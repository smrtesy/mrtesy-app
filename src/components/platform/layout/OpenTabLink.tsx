"use client";

import Link from "next/link";
import { isEmbeddedPane, requestOpenTab } from "@/lib/navigate";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";
import { useOptionalPaneNav } from "@/lib/panes/nav";

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
  "aria-label": ariaLabel,
  children,
}: {
  /** Locale-prefixed href, e.g. `/he/log`. Also the tab id (dedup key). */
  href: string;
  /** Pane-header label for the opened tab. */
  label: string;
  className?: string;
  title?: string;
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
          tabs.openTab(href, label);
          return;
        }
        // Legacy iframe pane — bridge to the top window.
        if (isEmbeddedPane()) {
          e.preventDefault();
          requestOpenTab(href, label);
        }
      }}
    >
      {children}
    </Link>
  );
}
