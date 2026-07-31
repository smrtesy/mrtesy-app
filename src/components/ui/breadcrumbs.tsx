"use client";

/**
 * Breadcrumbs — the standing hierarchy anchor for every screen that has a
 * hierarchy. House rule (2026-07): it sits at the TOP-LEFT of the screen (a
 * top row, `dir="ltr"` so the path reads left→right with a chevron between
 * each level), and every level except the last is navigable — a `href`
 * (PaneLink, keeps the workspace pane) or an `onClick` (collapse/return in
 * place). The last crumb is the current location and is not a link.
 *
 * Use this on any hierarchical page instead of hand-rolling a breadcrumb, so
 * the look and behavior stay identical everywhere.
 */
import { ChevronRight } from "lucide-react";

import { PaneLink } from "@/lib/panes/nav";

export type Crumb = {
  label: string;
  /** Navigate to this route (kept inside the pane). */
  href?: string;
  /** Or collapse/return in place (e.g. close an open item). */
  onClick?: () => void;
};

export function Breadcrumbs({ items, className = "" }: { items: Crumb[]; className?: string }) {
  if (items.length === 0) return null;
  return (
    <nav
      dir="ltr"
      aria-label="breadcrumb"
      className={`flex items-center gap-1 text-xs text-muted-foreground ${className}`}
    >
      {items.map((c, i) => {
        const last = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            {last ? (
              <span className="font-medium text-foreground">{c.label}</span>
            ) : c.href ? (
              <PaneLink href={c.href} className="hover:text-foreground hover:underline">
                {c.label}
              </PaneLink>
            ) : c.onClick ? (
              <button type="button" onClick={c.onClick} className="hover:text-foreground hover:underline">
                {c.label}
              </button>
            ) : (
              <span>{c.label}</span>
            )}
            {!last && <ChevronRight className="h-3 w-3 shrink-0" />}
          </span>
        );
      })}
    </nav>
  );
}
