"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Share, X, Plus } from "lucide-react";

const DISMISS_KEY = "smrt_pwa_install_dismissed";
const DISMISS_DAYS = 14;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes this non-standard flag when launched from the home screen.
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

function recentlyDismissed(): boolean {
  try {
    const ts = window.localStorage.getItem(DISMISS_KEY);
    if (!ts) return false;
    return Date.now() - Number(ts) < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

/**
 * A small, dismissible banner that guides the user to install the app to their
 * home screen for the chrome-less standalone experience.
 *
 * Two paths: Android/desktop Chrome fire `beforeinstallprompt`, which we
 * capture and replay behind our own button; iOS Safari has no such event, so
 * we show the manual "Share → Add to Home Screen" instructions instead.
 */
export function PWAInstallPrompt() {
  const t = useTranslations("pwa");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone() || recentlyDismissed()) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // iOS never fires the event, so offer the manual hint there.
    if (isIos()) setShowIosHint(true);

    const onInstalled = () => {
      setDeferred(null);
      setShowIosHint(false);
    };
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore storage failures (private mode) */
    }
    setDeferred(null);
    setShowIosHint(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };

  if (!deferred && !showIosHint) return null;

  return (
    <div
      role="dialog"
      aria-label={t("installTitle")}
      className="fixed inset-x-3 z-[60] mx-auto max-w-md rounded-2xl border border-border bg-card p-4 shadow-lg"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Download className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{t("installTitle")}</p>
          {showIosHint ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rich("iosBody", {
                share: () => (
                  <Share className="mx-0.5 inline h-4 w-4 align-text-bottom" />
                ),
                add: () => (
                  <Plus className="mx-0.5 inline h-4 w-4 align-text-bottom" />
                ),
              })}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">{t("installBody")}</p>
          )}
          {!showIosHint && (
            <button
              type="button"
              onClick={install}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground active:scale-[0.98]"
            >
              <Download className="h-4 w-4" />
              {t("installButton")}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t("dismiss")}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
