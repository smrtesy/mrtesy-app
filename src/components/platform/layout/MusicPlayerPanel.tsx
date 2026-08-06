"use client";

import { useTranslations } from "next-intl";
import { Music, ExternalLink } from "lucide-react";

const PLAYER_URL = "https://24six.app";

/**
 * A quiet 24Six launcher docked at the bottom of the DESKTOP sidebar. The
 * sidebar itself is `hidden md:flex`, so this is desktop-only by construction.
 *
 * It OPENS 24six.app in a full browser tab rather than embedding it in an
 * iframe. 24Six runs on Laravel (session + CSRF cookies); inside an iframe
 * those are third-party cookies the browser blocks, so an embedded player
 * can't stay logged in — it returns HTTP 419 ("token expired") on login. A
 * first-party tab keeps its own 24Six login cookies, so the player works
 * there. (We tried the iframe first; it 419'd on login exactly as predicted,
 * which is why this is a launcher, not an embed.)
 */
export function MusicPlayerPanel() {
  const t = useTranslations("nav");
  return (
    <div className="shrink-0 border-t p-3">
      <a
        href={PLAYER_URL}
        target="_blank"
        rel="noopener noreferrer"
        title={t("musicTooltip")}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Music className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">{t("music")}</span>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </a>
    </div>
  );
}
