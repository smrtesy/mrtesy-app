"use client";

/**
 * MarkdownTabLink — the link renderer for Claude-authored markdown.
 *
 * A link Claude emits to one of the app's own screens (`/he/tasks`,
 * `https://app.smrtesy.com/plan/team`, …) should land the user on that screen
 * as a NEW workspace tab — the same behaviour as clicking the sidebar — not a
 * new browser window that leaves the workspace behind. So an in-app target
 * opens through `OpenTabLink` (component pane → sibling tab; legacy iframe pane
 * → bridge to the top window; outside a pane → plain navigation — never a new
 * browser window). An external target (github, google docs, mailto) stays a
 * normal `target="_blank"` link.
 *
 * Pass this as `linkComponent` to `<Markdown>`. The header of the tab an in-app
 * link opens is derived from the route the same way an OAuth-return or
 * pasted-deep-link pane gets its name (`route-label`), so it matches the
 * sidebar's name for that section.
 */

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";

import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { toInAppPath } from "@/lib/navigate";
import { stripLocale } from "@/lib/panes/nav";
import { navLabelKeyFor, fallbackRouteLabel } from "@/lib/panes/route-label";

export function MarkdownTabLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const locale = useLocale();
  const t = useTranslations("nav");
  const inApp = toInAppPath(href);

  if (inApp) {
    // OpenTabLink wants a locale-prefixed href; add it unless the path already
    // carries a locale segment.
    const hasLocale = /^\/(he|en)(\/|$)/.test(inApp);
    const withLocale = hasLocale ? inApp : `/${locale}${inApp}`;
    // Label + tab-id are computed from the path alone (drop query/fragment).
    const stripped = stripLocale(withLocale.split("?")[0].split("#")[0]);
    const key = navLabelKeyFor(stripped);
    // Only a real app SCREEN opens as a workspace tab: one we can name (a
    // sidebar section owns it) or one that already carries a locale, i.e. a
    // full screen URL. A bare in-app path we can't name (`/api/*`, `/embed/*`)
    // is NOT a pane target — locale-prefixing it and opening a client-side tab
    // would 404 — so it falls through to a normal new-browser-tab link.
    if (hasLocale || key) {
      const label = key && t.has(key) ? t(key) : fallbackRouteLabel(stripped);
      return (
        <OpenTabLink href={withLocale} label={label} className={className}>
          {children}
        </OpenTabLink>
      );
    }
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}
