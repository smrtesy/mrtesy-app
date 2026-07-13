"use client";

/**
 * Pane screen registry (docs/router-panes-plan.md §4.1).
 *
 * Maps a pane href to a directly-rendered component. A screen listed here
 * opens instantly inside a tabs-workspace pane; anything NOT listed falls
 * back to the legacy iframe automatically (PaneHost), so migration is
 * per-screen and reversible by deleting an entry.
 *
 * Each entry's render replicates its route page's markup 1:1 (same wrappers,
 * same translation keys) so a screen looks identical whether it renders as a
 * routed page or inside a pane. Register ONLY screens whose components don't
 * touch next/navigation, or that have been migrated to the useScreen* hooks
 * in src/lib/panes/nav.tsx.
 */

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { LogPageClient } from "@/app/[locale]/(app)/(smrttask)/log/LogPageClient";
import { AutoReplyManager } from "@/components/smrttask/whatsapp/AutoReplyManager";
import { ContactsClient } from "@/components/smrtcrm/ContactsClient";
import { CrmManagePanel } from "@/components/smrtcrm/CrmManagePanel";
import { VaultClient } from "@/components/smrtvault/VaultClient";
import { PlanBoardClient } from "@/components/smrtplan/PlanBoardClient";
import { TeamViewClient } from "@/components/smrtplan/TeamViewClient";
import { PlanRepositoryClient } from "@/components/smrtplan/PlanRepositoryClient";

export type PaneScreen = {
  /** Matched against the locale-stripped pane pathname, e.g. "/plan/team". */
  match: (path: string) => boolean;
  render: (locale: string) => ReactNode;
};

// ── per-screen wrappers (mirror the route pages) ────────────────────────────

function LogPane({ locale }: { locale: string }) {
  const t = useTranslations("log");
  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 text-start">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <span className="text-xs text-muted-foreground">{t("window48h")}</span>
      </div>
      <LogPageClient locale={locale} />
    </div>
  );
}

function CrmPane() {
  const t = useTranslations("smrtCRM");
  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <ContactsClient />
      <CrmManagePanel />
    </div>
  );
}

function VaultPane() {
  const t = useTranslations("smrtVault");
  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <VaultClient />
    </div>
  );
}

// ── registry ────────────────────────────────────────────────────────────────

const PANE_SCREENS: PaneScreen[] = [
  { match: (p) => p === "/log", render: (locale) => <LogPane locale={locale} /> },
  { match: (p) => p === "/crm", render: () => <CrmPane /> },
  { match: (p) => p === "/vault", render: () => <VaultPane /> },
  { match: (p) => p === "/plan", render: (locale) => <PlanBoardClient locale={locale} /> },
  { match: (p) => p === "/plan/team", render: (locale) => <TeamViewClient locale={locale} /> },
  {
    match: (p) => p === "/plan/repository",
    render: (locale) => <PlanRepositoryClient locale={locale} />,
  },
  { match: (p) => p === "/whatsapp/autoreply", render: () => <AutoReplyManager /> },
];

export function resolvePaneScreen(path: string): PaneScreen | null {
  return PANE_SCREENS.find((s) => s.match(path)) ?? null;
}
