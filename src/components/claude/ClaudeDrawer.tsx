"use client";

/**
 * ClaudeDrawer — the in-app Claude console as a floating, collapsible side chat.
 *
 * A launcher button (bottom corner) opens a compact drawer that floats above
 * whatever screen you're on — NOT a full tab, NOT full screen height. Inside it
 * hosts the real /claude console in an iframe (`?embed=1`, which strips the app
 * chrome), so the drawer inherits every console feature and future change with
 * zero duplication, and the framed URL/router state stays fully isolated from
 * the host screen it floats over.
 *
 * Two things make the iframe safe here:
 *   1. Recursion guard — the framed /claude loads (app)/layout.tsx again, which
 *      would mount a second ClaudeDrawer inside the frame. We render NOTHING when
 *      this window is itself embedded (framed OR ?embed=1), and globals.css also
 *      hides [data-claude-drawer] under html[data-embed="1"] as a belt-and-braces
 *      first-paint guard. So the drawer never nests.
 *   2. Admin-only — mounted in the layout behind `isAdmin`, matching the /claude
 *      routes' super-admin gate (a run executes shell on our host).
 *
 * Mounted once in the layout, it survives pane navigation (the layout doesn't
 * remount), and the iframe stays alive once opened so the conversation persists
 * while you toggle the drawer closed and open again.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, X, Maximize2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const OPEN_KEY = "claude-drawer-open";

export function ClaudeDrawer({ locale }: { locale: string }) {
  const t = useTranslations("claudeDrawer");
  // Client-only gate. Starts false so the server render and the first client
  // render match (nothing), then flips to true only when this window is a
  // real top-level document — never inside the console's own iframe.
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  // Mount the (heavy) iframe only after the first open, then keep it alive so
  // the conversation survives a close/reopen.
  const [loaded, setLoaded] = useState(false);
  // The framed app takes a moment to boot — show a spinner until its first load.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let framed = false;
    try {
      framed =
        window.self !== window.top ||
        document.documentElement.getAttribute("data-embed") === "1";
    } catch {
      // Cross-origin access to window.top throws → we are framed.
      framed = true;
    }
    if (framed) return; // recursion guard: never mount inside the console iframe
    setEnabled(true);
    try {
      setOpen(window.localStorage.getItem(OPEN_KEY) === "1");
    } catch {
      /* localStorage may be unavailable (private mode) — default closed */
    }
  }, []);

  const setOpenPersisted = useCallback((next: boolean) => {
    setOpen(next);
    if (next) setLoaded(true);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, []);

  // Escape closes the drawer (only while open, so it doesn't swallow Escape for
  // other screens when the drawer is closed).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenPersisted(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpenPersisted]);

  if (!enabled) return null;

  return (
    <div data-claude-drawer>
      {/* Launcher — shown only while the drawer is closed. Sits above the mobile
          bottom nav on small screens, and clears the corner on desktop. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpenPersisted(true)}
          aria-label={t("launch")}
          title={t("launch")}
          className={cn(
            "fixed z-[60] flex items-center gap-2 rounded-2xl px-4 py-3",
            "bottom-20 md:bottom-6 start-4 md:start-56",
            "bg-primary text-primary-foreground shadow-lg",
            "transition hover:-translate-y-0.5 hover:opacity-95",
          )}
        >
          <Sparkles className="size-5" />
          <span className="hidden text-sm font-medium sm:inline">{t("launch")}</span>
        </button>
      )}

      {/* The drawer. Kept in the DOM once opened (via `loaded`), hidden rather
          than unmounted so the iframe conversation survives a close/reopen.
          Deliberately NOT full height — a floating card, clamped to the viewport
          on small screens. */}
      {loaded && (
        <div
          className={cn(
            "fixed z-[60] flex flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl",
            "bottom-20 md:bottom-6 start-4 md:start-56",
            "w-[min(26rem,calc(100vw-2rem))] h-[min(38rem,calc(100dvh-7rem))]",
            !open && "hidden",
          )}
          role="dialog"
          aria-label={t("title")}
        >
          <header className="flex items-center gap-2 border-b px-3 py-2">
            <Sparkles className="size-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t("title")}</span>
            <a
              href={`/${locale}/claude`}
              aria-label={t("openFull")}
              title={t("openFull")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <Maximize2 className="size-4" />
            </a>
            <button
              type="button"
              onClick={() => setOpenPersisted(false)}
              aria-label={t("close")}
              title={t("close")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </header>
          <div className="relative min-h-0 w-full flex-1">
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("loading")}
              </div>
            )}
            <iframe
              src={`/${locale}/claude?embed=1`}
              title={t("title")}
              onLoad={() => setReady(true)}
              className="h-full w-full border-0"
            />
          </div>
        </div>
      )}
    </div>
  );
}
