"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Download } from "lucide-react";
import { usePwaInstall } from "@/lib/pwa/install";

/**
 * Compact "install app" button for the home page header.
 *
 * Renders nothing when the app is already installed (standalone) or when the
 * platform offers no install path, so it never leaves an empty slot in the
 * layout. On Android/desktop Chrome it replays the captured native prompt; on
 * iOS Safari — which has no install API — it surfaces the manual
 * Share → Add to Home Screen instructions as a toast.
 */
export function InstallAppButton() {
  const t = useTranslations("pwa");
  const { canPrompt, ios, standalone, promptInstall } = usePwaInstall();

  // Already installed, or no way to install on this platform → show nothing.
  if (standalone || (!canPrompt && !ios)) return null;

  const handleClick = async () => {
    if (canPrompt) {
      await promptInstall();
    } else {
      // iOS: there's no programmatic prompt, so guide the user.
      toast.info(t("installTitle"), { description: t("iosToast"), duration: 8000 });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-primary/10 active:scale-[0.98]"
    >
      <Download className="h-4 w-4" />
      {t("installButton")}
    </button>
  );
}
