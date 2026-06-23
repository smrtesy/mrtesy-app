"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { SmrtName } from "@/components/icons/SmrtName";
import type { AppDef } from "@/lib/apps/registry";
import { useOptionalTabsWorkspace } from "@/contexts/TabsWorkspaceContext";

/** On desktop, open a chrome link as a workspace pane instead of a full-window
 *  navigation the panes would hide. Returns an onClick handler, or undefined
 *  when there's no workspace / on narrow widths (navigate normally). */
function useOpenAsTab() {
  const workspace = useOptionalTabsWorkspace();
  return (href: string, label: string) => (e: React.MouseEvent) => {
    if (
      workspace &&
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      e.preventDefault();
      workspace.openTab(href, label);
    }
  };
}

/**
 * Sidebar section header for an app. Two click targets:
 *  - icon  → app settings
 *  - name  → app guide
 *
 * Same pattern used inside the mobile "More" sheet so the user has a
 * single mental model: name = guide, icon = settings.
 */
export function AppSectionHeader({
  app,
  className,
}: {
  app: AppDef;
  className?: string;
}) {
  const { locale } = useParams() as { locale: string };
  const t = useTranslations("nav");
  const openAsTab = useOpenAsTab();
  const base = `/${locale}`;
  const appName = `smrt${app.word}`;
  return (
    <div className={cn("flex items-center gap-2 px-3 pb-1 pt-4", className)}>
      <Link
        href={`${base}${app.settingsHref}`}
        aria-label={`${app.slug} settings`}
        onClick={openAsTab(`${base}${app.settingsHref}`, `${appName} · ${t("settings")}`)}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
      >
        <app.Icon className="h-4 w-4" />
      </Link>
      <Link
        href={`${base}${app.guideHref}`}
        onClick={openAsTab(`${base}${app.guideHref}`, appName)}
        className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80 hover:text-foreground"
      >
        <SmrtName word={app.word} />
      </Link>
    </div>
  );
}
