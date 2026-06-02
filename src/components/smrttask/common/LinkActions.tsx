"use client";

import { useTranslations } from "next-intl";
import {
  Video,
  FileText,
  FileSpreadsheet,
  Presentation,
  Folder,
  Calendar,
  Mail,
  MessageCircle,
  ExternalLink,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { linkHost, type DetectedLink, type LinkKind } from "@/lib/smrttask/links";

const ICONS: Record<LinkKind, LucideIcon> = {
  zoom: Video,
  meet: Video,
  teams: Video,
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  drive: Folder,
  calendar: Calendar,
  gmail: Mail,
  whatsapp: MessageCircle,
  generic: ExternalLink,
};

// i18n key per kind (under tasks.linkActions). "generic" has no fixed label —
// we show the bare hostname instead, which is more useful than "Open link".
const LABEL_KEYS: Record<Exclude<LinkKind, "generic">, string> = {
  zoom: "joinZoom",
  meet: "joinMeet",
  teams: "joinTeams",
  doc: "openDoc",
  sheet: "openSheet",
  slides: "openSlides",
  drive: "openDrive",
  calendar: "openCalendar",
  gmail: "openEmail",
  whatsapp: "openWhatsapp",
};

/**
 * Renders one button per detected link on a task, so the user can act (join a
 * Zoom call, open a doc) straight from the card without opening it. Clicks
 * stopPropagation so they open the link rather than the card's detail sheet.
 */
export function LinkActions({ links }: { links: DetectedLink[] }) {
  const t = useTranslations("tasks.linkActions");
  if (links.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {links.map((link, i) => {
        const Icon = ICONS[link.kind];
        const label = link.kind === "generic" ? linkHost(link.url) : t(LABEL_KEYS[link.kind]);
        return (
          <Button
            key={`${link.url}-${i}`}
            variant="outline"
            size="sm"
            className="h-8 max-w-full min-w-0 text-xs gap-1"
            title={link.url}
            onClick={(e) => {
              e.stopPropagation();
              window.open(link.url, "_blank", "noopener,noreferrer");
            }}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span className="truncate" dir="ltr">{label}</span>
          </Button>
        );
      })}
    </div>
  );
}
