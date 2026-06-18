"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Share, X, Plus } from "lucide-react";
import { usePwaInstall } from "@/lib/pwa/install";

const DISMISS_KEY = "smrt_pwa_install_dismissed";
const DISMISS_DAYS = 14;

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
 * Install availability comes from the shared `usePwaInstall` store (kept in
 * sync with the header InstallAppButton): Android/desktop Chrome expose a
 * native prompt we replay; iOS Safari has none, so we show the manual
 * "Share → Add to Home Screen" instructions instead.
 */
export function PWAInstallPrompt() {
  const t = useTranslations("pwa");
  const { canPrompt, ios, standalone, promptInstall } = usePwaInstall();
  const [dismissed, setDismissed] = useState(true);

  // Read the dismissal flag on the client only (avoids SSR/localStorage mismatch).
  useEffect(() => {
    setDismissed(recentlyDismissed());
  }, []);

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore storage failures (private mode) */
    }
    setDismissed(true);
  };

  // Hide when installed, recently dismissed, or there's nothing to offer yet.
  if (standalone || dismissed || (!canPrompt && !ios)) return null;

  const showIosHint = !canPrompt && ios;

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
              onClick={() => promptInstall()}
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
