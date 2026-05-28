import type { ComponentType } from "react";
import { SmrtTaskIcon } from "@/components/icons/SmrtTaskIcon";
import { SmrtVoiceIcon } from "@/components/icons/SmrtVoiceIcon";

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
};

export function getApp(slug: string): AppDef | undefined {
  return APPS[slug];
}
