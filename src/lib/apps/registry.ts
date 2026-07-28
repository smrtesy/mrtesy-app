import type { ComponentType } from "react";
import { SmrtTaskIcon } from "@/components/icons/SmrtTaskIcon";
import { SmrtVoiceIcon } from "@/components/icons/SmrtVoiceIcon";
import { SmrtCRMIcon } from "@/components/icons/SmrtCRMIcon";
import { SmrtReachIcon } from "@/components/icons/SmrtReachIcon";
import { SmrtBotIcon } from "@/components/icons/SmrtBotIcon";
import { SmrtPlanIcon } from "@/components/icons/SmrtPlanIcon";
import { SmrtVaultIcon } from "@/components/icons/SmrtVaultIcon";
import { SmrtInfoIcon } from "@/components/icons/SmrtInfoIcon";
import { SmrtStudioIcon } from "@/components/icons/SmrtStudioIcon";

/**
 * The built-in admin section cards an app exposes on its
 * /admin/apps/[slug] detail page. Each key maps to a sub-page under that
 * route. `guide` is not listed here — it's appended automatically when the
 * app row carries a `guide_url`.
 *
 * Most of these surfaces used to render for every app even though they only
 * made sense for smrtTask (Gmail/Drive/Calendar/WhatsApp sync, WhatsApp
 * secrets, smrtTask system params). Declaring them per-app keeps each app's
 * detail page to the settings that actually apply to it.
 */
export type AdminSectionKey =
  | "services"
  | "prompts"
  | "quality"
  | "secrets"
  | "parameters"
  | "documents";

export interface AppDef {
  slug: string;
  /** Second word after "smrt" — used by SmrtName to render the styled label. */
  word: string;
  Icon: ComponentType<{ className?: string }>;
  /** Path to the app's guide page (relative, without locale). */
  guideHref: string;
  /** Path to the app's settings tab inside /settings. */
  settingsHref: string;
  /**
   * Per-app accent color (hex). Rendered as the thin category bar beside the
   * app name in the sidebar section header. Applied via inline style so the
   * arbitrary hex survives Tailwind's purge. Chosen to read on both the light
   * and dark sidebar backgrounds (mid-tone, not too pale / not too dark).
   */
  color: string;
}

export const APPS: Record<string, AppDef> = {
  smrttask: {
    slug: "smrttask",
    word: "Task",
    Icon: SmrtTaskIcon,
    guideHref: "/tasks/guide",
    settingsHref: "/settings/apps/smrttask",
    color: "#3b82f6",
  },
  smrtvoice: {
    slug: "smrtvoice",
    word: "Voice",
    Icon: SmrtVoiceIcon,
    guideHref: "/voice/guide",
    settingsHref: "/settings/apps/smrtvoice",
    color: "#8b5cf6",
  },
  smrtcrm: {
    slug: "smrtcrm",
    word: "CRM",
    Icon: SmrtCRMIcon,
    guideHref: "/crm/guide",
    settingsHref: "/settings/apps/smrtcrm",
    color: "#10b981",
  },
  smrtreach: {
    slug: "smrtreach",
    word: "Reach",
    Icon: SmrtReachIcon,
    guideHref: "/reach/guide",
    settingsHref: "/settings/apps/smrtreach",
    color: "#f59e0b",
  },
  smrtbot: {
    slug: "smrtbot",
    word: "Bot",
    Icon: SmrtBotIcon,
    guideHref: "/bots/guide",
    settingsHref: "/settings/apps/smrtbot",
    color: "#06b6d4",
  },
  smrtplan: {
    slug: "smrtplan",
    word: "Plan",
    Icon: SmrtPlanIcon,
    guideHref: "/plan/guide",
    settingsHref: "/settings/apps/smrtplan",
    color: "#ec4899",
  },
  smrtvault: {
    slug: "smrtvault",
    word: "Vault",
    Icon: SmrtVaultIcon,
    guideHref: "/vault/guide",
    settingsHref: "/settings/apps/smrtvault",
    color: "#64748b",
  },
  smrtinfo: {
    slug: "smrtinfo",
    word: "Info",
    Icon: SmrtInfoIcon,
    guideHref: "/info/guide",
    settingsHref: "/settings/apps/smrtinfo",
    color: "#14b8a6",
  },
  smrtstudio: {
    slug: "smrtstudio",
    word: "Studio",
    Icon: SmrtStudioIcon,
    guideHref: "/studio",
    settingsHref: "/settings/apps/smrtstudio",
    color: "#a855f7",
  },
};

export function getApp(slug: string): AppDef | undefined {
  return APPS[slug];
}

/**
 * Which admin detail-page cards each app shows, in display order. Kept
 * separate from APPS because some apps (e.g. smrtplan) have an admin surface
 * without being a launchable app in the registry.
 *
 * These used to be identical for every app even though most only applied to
 * smrtTask. The AI-prompts catalog is smrtTask-only (no other app defines
 * prompts), service sync / WhatsApp secrets / system params are smrtTask-only,
 * and voice keys are env-managed. So only smrtTask gets the full set; other
 * apps get what actually applies to them. Every app can carry plan/spec
 * documents (app_plans), so `documents` is the universal fallback.
 */
const ADMIN_SECTIONS: Record<string, AdminSectionKey[]> = {
  // `quality` sits next to `prompts` on purpose: it is the feedback loop for
  // the prompts above it (correction rate, silent parse failures, cost per
  // message). smrtTask-only, because it reads the classifier's own tables.
  smrttask: ["services", "prompts", "quality", "secrets", "parameters", "documents"],
  smrtvoice: ["secrets", "documents"],
  smrtcrm: ["documents"],
  smrtreach: ["secrets", "documents"],
  smrtbot: ["secrets", "documents"],
  smrtplan: ["documents"],
  smrtvault: ["documents"],
  smrtinfo: ["documents"],
  smrtstudio: ["documents"],
};

export function getAdminSections(slug: string): AdminSectionKey[] {
  return ADMIN_SECTIONS[slug] ?? ["documents"];
}
