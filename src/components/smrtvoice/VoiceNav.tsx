"use client";

import { PaneLink, useScreenPathname } from "@/lib/panes/nav";
import { useLocale, useTranslations } from "next-intl";
import { Folder, Users, Library, Lightbulb } from "lucide-react";

/**
 * Compact in-app sub-nav for smrtVoice: Folders · Characters · Voice library.
 * Kept minimal (icon + label pills) per the compact-UI principle.
 */
export function VoiceNav() {
  const t = useTranslations("smrtVoice.nav");
  const locale = useLocale();
  const pathname = useScreenPathname();

  const items = [
    // Stage G (smrtVoice absorbed into smrtStudio): the folders tab leads to
    // the studio project list — /voice itself only redirects there, and
    // linking the redirect from inside a pane would drop the user into an
    // iframe of the full app shell. The match regex still lights this tab up
    // on the voice project/script screens.
    { href: `/${locale}/studio/projects`, label: t("folders"), Icon: Folder, match: /\/voice$|\/voice\/(projects|scripts)(\/|$)/ },
    { href: `/${locale}/voice/characters`, label: t("characters"), Icon: Users, match: /\/voice\/characters(\/|$)/ },
    { href: `/${locale}/voice/library`, label: t("library"), Icon: Library, match: /\/voice\/library(\/|$)/ },
    { href: `/${locale}/voice/insights`, label: t("insights"), Icon: Lightbulb, match: /\/voice\/insights(\/|$)/ },
  ];

  return (
    <nav className="flex flex-wrap items-center gap-1.5">
      {items.map(({ href, label, Icon, match }) => {
        const active = match.test(pathname);
        return (
          <PaneLink
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
          </PaneLink>
        );
      })}
    </nav>
  );
}
