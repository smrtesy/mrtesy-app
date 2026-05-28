"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { SmrtName } from "@/components/icons/SmrtName";
import type { AppDef } from "@/lib/apps/registry";

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
  const base = `/${locale}`;
  return (
    <div className={cn("flex items-center gap-2 px-3 pb-1 pt-4", className)}>
      <Link
        href={`${base}${app.settingsHref}`}
        aria-label={`${app.slug} settings`}
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent"
      >
        <app.Icon className="h-4 w-4" />
      </Link>
      <Link
        href={`${base}${app.guideHref}`}
        className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground/80 hover:text-foreground"
      >
        <SmrtName word={app.word} />
      </Link>
    </div>
  );
}
