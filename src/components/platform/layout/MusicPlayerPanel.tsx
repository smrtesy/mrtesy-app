"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Music, Maximize2, X } from "lucide-react";

const PLAYER_URL = "https://24six.app";
const STORAGE_KEY = "smrtesy:24six-player-open";

/**
 * A compact, collapsed-by-default 24Six music player docked at the bottom of the
 * DESKTOP sidebar. The sidebar itself is `hidden md:flex`, so this panel is
 * desktop-only by construction — which is what the user asked for.
 *
 * Collapsed (default, per the compact-UI rule): one quiet icon row.
 * Expanded: an embedded iframe of the 24Six web player + an "open in full tab"
 * button.
 *
 * Cookie caveat (why the full-tab button exists): the embedded iframe only stays
 * logged in when the browser allows third-party cookies (desktop Chrome does, by
 * default, as of 2026). The "open in full tab" button is the always-works
 * fallback — a first-party tab keeps its own 24Six login cookies regardless.
 */
export function MusicPlayerPanel() {
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);

  // Restore last state so the player stays open across navigations / reloads.
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      /* localStorage may be unavailable — default to collapsed */
    }
  }, []);

  const toggle = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* ignore persistence failure */
    }
  };

  if (!open) {
    return (
      <div className="shrink-0 border-t p-3">
        <button
          type="button"
          onClick={() => toggle(true)}
          title={t("musicTooltip")}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Music className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("music")}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Music className="h-4 w-4 shrink-0" />
          <span className="truncate">{t("music")}</span>
        </div>
        <div className="flex items-center gap-1">
          <a
            href={PLAYER_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={t("musicExpandTab")}
            aria-label={t("musicExpandTab")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={() => toggle(false)}
            title={t("musicClose")}
            aria-label={t("musicClose")}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <iframe
        src={PLAYER_URL}
        title="24Six"
        allow="autoplay; encrypted-media; clipboard-write"
        className="w-full rounded-lg border bg-background"
        style={{ height: "clamp(220px, 46vh, 460px)" }}
      />
    </div>
  );
}
