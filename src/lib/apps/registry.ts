import type { ComponentType } from "react";
import { SmrtTaskIcon } from "@/components/icons/SmrtTaskIcon";
import { SmrtVoiceIcon } from "@/components/icons/SmrtVoiceIcon";

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
  /** Which admin detail-page cards this app shows, in display order. */
  adminSections: AdminSectionKey[];
}

export const APPS: Record<string, AppDef> = {
  smrttask: {
    slug: "smrttask",
    word: "Task",
    Icon: SmrtTaskIcon,
    guideHref: "/tasks/guide",
    settingsHref: "/settings/apps/smrttask",
    adminSections: ["services", "prompts", "secrets", "parameters", "documents"],
  },
  smrtvoice: {
    slug: "smrtvoice",
    word: "Voice",
    Icon: SmrtVoiceIcon,
    guideHref: "/voice/guide",
    settingsHref: "/settings/apps/smrtvoice",
    // No Gmail/Drive/Calendar/WhatsApp sync and no smrtTask params; voice
    // keys are read-only (env-managed, shared with the Python voice-engine).
    adminSections: ["prompts", "secrets", "documents"],
  },
};

export function getApp(slug: string): AppDef | undefined {
  return APPS[slug];
}

/**
 * Admin detail-page sections for a slug. Unregistered apps fall back to the
 * universally-applicable cards (every app has AI prompts and may carry docs).
 */
export function getAdminSections(slug: string): AdminSectionKey[] {
  return APPS[slug]?.adminSections ?? ["prompts", "documents"];
}
