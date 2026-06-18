"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Settings, MessageSquareText, Gamepad2, Inbox, BarChart3, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Two-level bot nav: five top-level sections (with icons), each revealing its
 * own row of sub-tabs. Routes are unchanged — `active` is the current sub-tab
 * key (pages pass it; the root/identity page passes nothing → "general"), and
 * the section is derived from whichever group contains that key.
 */
interface NavItem {
  /** URL segment under /bots/[botId] ("" = the root identity page). */
  seg: string;
  /** Stable key pages pass as `active` (defaults to seg). */
  key?: string;
  /** i18n key for the label; falls back to res_<seg> then the raw seg. */
  labelKey?: string;
}
interface Section {
  key: string;
  icon: LucideIcon;
  labelKey: string;
  items: NavItem[];
}

const SECTIONS: Section[] = [
  {
    key: "content",
    icon: MessageSquareText,
    labelKey: "secContent",
    items: [
      { seg: "menu" }, { seg: "messages" }, { seg: "knowledge" },
      { seg: "phone-routes" }, { seg: "auto-messages" }, { seg: "scheduled" },
      { seg: "holidays" },
    ],
  },
  {
    key: "game",
    icon: Gamepad2,
    labelKey: "secGame",
    items: [
      { seg: "missions" }, { seg: "trivia" }, { seg: "children" },
      { seg: "coupons" }, { seg: "raffles" },
    ],
  },
  {
    key: "inbox",
    icon: Inbox,
    labelKey: "secInbox",
    items: [{ seg: "questions" }, { seg: "feedback" }],
  },
  {
    key: "data",
    icon: BarChart3,
    labelKey: "secData",
    items: [
      { seg: "stats", labelKey: "statsTitle" },
      { seg: "logs", labelKey: "logsTitle" },
      { seg: "webhook-debug" },
      { seg: "contacts" },
      { seg: "study-sessions" },
      { seg: "prayers" },
      { seg: "pm-projects" },
      { seg: "pm-entries" },
    ],
  },
  {
    key: "settings",
    icon: Settings,
    labelKey: "secSettings",
    items: [
      { seg: "", key: "general", labelKey: "tabBasic" },
      { seg: "whatsapp", labelKey: "waTab" },
      { seg: "web", labelKey: "webTab" },
      { seg: "settings", labelKey: "settingsAdvanced" },
      { seg: "publish", labelKey: "publishTitle" },
    ],
  },
];

const keyOf = (it: NavItem) => it.key ?? it.seg;

export function ResourceNav({ botId, active }: { botId: string; active?: string }) {
  const t = useTranslations("smrtBot");
  const locale = useLocale();
  const activeKey = active ?? "general";

  const itemLabel = (it: NavItem) => {
    if (it.labelKey && t.has(it.labelKey)) return t(it.labelKey);
    const rk = `res_${it.seg}`;
    return t.has(rk) ? t(rk) : it.seg;
  };

  const href = (seg: string) => `/${locale}/bots/${botId}${seg ? `/${seg}` : ""}`;

  const activeSection =
    SECTIONS.find((s) => s.items.some((it) => keyOf(it) === activeKey)) ?? SECTIONS[0];

  return (
    <div className="space-y-2 border-b border-border pb-2">
      {/* Top-level sections */}
      <div className="flex flex-wrap gap-1">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          const isActive = s.key === activeSection.key;
          return (
            <Link
              key={s.key}
              href={href(s.items[0].seg)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium hover:bg-muted",
                isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {t(s.labelKey)}
            </Link>
          );
        })}
      </div>

      {/* Sub-tabs of the active section */}
      <div className="flex flex-wrap gap-1 ps-1">
        {activeSection.items.map((it) => {
          const isActive = keyOf(it) === activeKey;
          return (
            <Link
              key={keyOf(it)}
              href={href(it.seg)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm hover:bg-muted",
                isActive ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground",
              )}
            >
              {itemLabel(it)}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
