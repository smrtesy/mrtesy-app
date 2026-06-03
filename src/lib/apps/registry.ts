import type { ComponentType } from "react";
import { SmrtTaskIcon } from "@/components/icons/SmrtTaskIcon";
import { SmrtVoiceIcon } from "@/components/icons/SmrtVoiceIcon";
import { SmrtBotIcon } from "@/components/icons/SmrtBotIcon";

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
}

export const APPS: Record<string, AppDef> = {
  smrttask: {
    slug: "smrttask",
    word: "Task",
    Icon: SmrtTaskIcon,
    guideHref: "/tasks/guide",
    settingsHref: "/settings/apps/smrttask",
  },
  smrtvoice: {
    slug: "smrtvoice",
    word: "Voice",
    Icon: SmrtVoiceIcon,
    guideHref: "/voice/guide",
    settingsHref: "/settings/apps/smrtvoice",
  },
  smrtbot: {
    slug: "smrtbot",
    word: "Bot",
    Icon: SmrtBotIcon,
    guideHref: "/bots/guide",
    settingsHref: "/settings/apps/smrtbot",
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
  smrttask: ["services", "prompts", "secrets", "parameters", "documents"],
  smrtvoice: ["secrets", "documents"],
  smrtbot: ["secrets", "documents"],
  smrtplan: ["documents"],
};

export function getAdminSections(slug: string): AdminSectionKey[] {
  return ADMIN_SECTIONS[slug] ?? ["documents"];
}
