"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Folder, Users, Library, Lightbulb } from "lucide-react";

/**
 * Compact in-app sub-nav for smrtVoice: Folders · Characters · Voice library.
 * Kept minimal (icon + label pills) per the compact-UI principle.
 */
export function VoiceNav() {
  const t = useTranslations("smrtVoice.nav");
  const locale = useLocale();
  const pathname = usePathname();

  const items = [
    { href: `/${locale}/voice`, label: t("folders"), Icon: Folder, match: /\/voice$|\/voice\/(projects|scripts)(\/|$)/ },
    { href: `/${locale}/voice/characters`, label: t("characters"), Icon: Users, match: /\/voice\/characters(\/|$)/ },
    { href: `/${locale}/voice/library`, label: t("library"), Icon: Library, match: /\/voice\/library(\/|$)/ },
    { href: `/${locale}/voice/insights`, label: t("insights"), Icon: Lightbulb, match: /\/voice\/insights(\/|$)/ },
  ];

  return (
    <nav className="flex flex-wrap items-center gap-1.5">
      {items.map(({ href, label, Icon, match }) => {
        const active = match.test(pathname);
        return (
          <Link
            key={href}
            href={href}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
