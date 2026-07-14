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
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";
import { PaneLink } from "@/lib/panes/nav";
import { OpenTabLink } from "@/components/platform/layout/OpenTabLink";
import { InboxTabs } from "@/components/platform/inbox/InboxTabs";
import { CorrectionsExportButton } from "@/components/smrttask/log/CorrectionsExportButton";

import { LogPageClient } from "@/app/[locale]/(app)/(smrttask)/log/LogPageClient";
import { TasksPageClient } from "@/components/smrttask/tasks/TasksPageClient";
import { WhatsAppPageClient } from "@/components/smrttask/whatsapp/WhatsAppPageClient";
import { SmsPageClient } from "@/components/smrttask/sms/SmsPageClient";
import { KnowledgeCenter } from "@/components/smrttask/knowledge/KnowledgeCenter";
import { AutoReplyManager } from "@/components/smrttask/whatsapp/AutoReplyManager";
import { ContactsClient } from "@/components/smrtcrm/ContactsClient";
import { CrmManagePanel } from "@/components/smrtcrm/CrmManagePanel";
import { VaultClient } from "@/components/smrtvault/VaultClient";
import { PlanBoardClient } from "@/components/smrtplan/PlanBoardClient";
import { TeamViewClient } from "@/components/smrtplan/TeamViewClient";
import { PlanRepositoryClient } from "@/components/smrtplan/PlanRepositoryClient";
import { VoiceNav } from "@/components/smrtvoice/VoiceNav";
import { ProjectsList } from "@/components/smrtvoice/ProjectsList";
import { BudgetIndicator } from "@/components/smrtvoice/BudgetIndicator";
import { CharactersList } from "@/components/smrtvoice/CharactersList";
import { BotsClient } from "@/components/smrtbot/BotsClient";
import { CampaignsClient } from "@/components/smrtreach/CampaignsClient";

export type PaneScreen = {
  /** Matched against the locale-stripped pane pathname, e.g. "/plan/team". */
  match: (path: string) => boolean;
  render: (locale: string) => ReactNode;
  /** Screens that manage their own internal scroll (chat readers) get a
   *  fixed full-height pane body instead of the padded scroll container. */
  fullHeight?: boolean;
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

function TasksPane() {
  const t = useTranslations("tasks");
  return <TasksPageClient title={t("title")} />;
}

/** Active org for cache keys — same precedence as api()'s X-Org-Id
 *  (subdomain cookie, then localStorage). Prevents a multi-org user from
 *  being served the previous org's cached data after switching. */
function activeOrgKey(): string {
  if (typeof document === "undefined") return "default";
  const m = document.cookie.match(/(?:^|;\s*)smrt_org_id=([^;]+)(?:;|$)/);
  return m ? decodeURIComponent(m[1]) : localStorage.getItem("smrtesy.active_org_id") ?? "default";
}

function InboxPane({ locale }: { locale: string }) {
  const t = useTranslations("inbox");
  const tNav = useTranslations("nav");
  // The routed page resolves the smrtTask entitlement server-side; the pane
  // asks the pre-existing /api/org/apps registry endpoint once and caches it
  // (entitlements change rarely).
  const { data, isError } = useQuery({
    queryKey: ["org-apps", activeOrgKey()],
    queryFn: () => api<{ apps: { slug: string; enabled: boolean }[] }>("/api/org/apps"),
    staleTime: 5 * 60 * 1000,
  });
  const hasSmrtTask = (data?.apps ?? []).some((a) => a.slug === "smrttask" && a.enabled);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <OpenTabLink
          href={`/${locale}/log`}
          label={tNav("log")}
          aria-label={t("openLog")}
          title={t("openLog")}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </OpenTabLink>
        {hasSmrtTask && (
          <div className="ms-auto">
            <CorrectionsExportButton refreshKey={0} />
          </div>
        )}
      </div>
      {/* Hold the tabs until the entitlement is known — mounting with
          hasSmrtTask=false and flipping would flash/reset the tab set. The
          query is cached, so reopening the pane renders immediately. On
          error, render without smrtTask so notifications stay reachable. */}
      {data || isError ? <InboxTabs locale={locale} hasSmrtTask={hasSmrtTask} /> : null}
    </div>
  );
}

function WhatsAppPane() {
  const t = useTranslations("whatsappPage");
  return <WhatsAppPageClient title={t("title")} />;
}

function SmsPane() {
  const t = useTranslations("smsPage");
  return <SmsPageClient title={t("title")} />;
}

function VoicePane({ locale }: { locale: string }) {
  const t = useTranslations("smrtVoice.folders");
  return (
    <div className="p-6 space-y-6">
      <VoiceNav />
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <BudgetIndicator />
          <PaneLink href={`/${locale}/voice/projects/new`}>
            <Button>
              <Plus className="w-4 h-4 me-2" />
              {t("new")}
            </Button>
          </PaneLink>
        </div>
      </div>
      <ProjectsList />
    </div>
  );
}

function VoiceCharactersPane() {
  const t = useTranslations("smrtVoice");
  return (
    <div className="p-6 space-y-6">
      <VoiceNav />
      <div>
        <h1 className="text-2xl font-bold">{t("characters.title")}</h1>
        <p className="text-muted-foreground">{t("characters.subtitle")}</p>
      </div>
      <CharactersList />
    </div>
  );
}

function BotsPane() {
  const t = useTranslations("smrtBot");
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <BotsClient />
    </div>
  );
}

function ReachPane() {
  const t = useTranslations("smrtReach");
  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <CampaignsClient />
    </div>
  );
}

// ── registry ────────────────────────────────────────────────────────────────

const PANE_SCREENS: PaneScreen[] = [
  { match: (p) => p === "/tasks", render: () => <TasksPane /> },
  { match: (p) => p === "/inbox", render: (locale) => <InboxPane locale={locale} /> },
  { match: (p) => p === "/whatsapp", render: () => <WhatsAppPane />, fullHeight: true },
  { match: (p) => p === "/sms", render: () => <SmsPane />, fullHeight: true },
  { match: (p) => p === "/knowledge", render: () => <KnowledgeCenter /> },
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
  { match: (p) => p === "/voice", render: (locale) => <VoicePane locale={locale} /> },
  { match: (p) => p === "/voice/characters", render: () => <VoiceCharactersPane /> },
  { match: (p) => p === "/bots", render: () => <BotsPane /> },
  { match: (p) => p === "/reach", render: () => <ReachPane /> },
];

export function resolvePaneScreen(path: string): PaneScreen | null {
  return PANE_SCREENS.find((s) => s.match(path)) ?? null;
}
