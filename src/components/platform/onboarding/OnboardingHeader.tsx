"use client";

import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

export function OnboardingHeader({ email }: { email: string }) {
  const tAuth = useTranslations("auth");
  const t = useTranslations("onboarding");
  const { locale } = useParams();
  const router = useRouter();
  const supabase = createClient();

  async function handleSignOut() {
    await supabase.auth.signOut();
    // Wipe SW-cached pages/data so the next user on this device can't replay
    // this account's shell (mirrors the sign-out in AccountClient).
    try {
      const reg = await navigator.serviceWorker?.ready;
      reg?.active?.postMessage("CLEAR_CACHE");
    } catch {
      /* no SW (dev or unsupported) — nothing cached to clear */
    }
    router.push(`/${locale}/login`);
  }

  return (
    <div className="w-full max-w-md mx-auto mb-6 flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
      <div className="flex flex-col min-w-0">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("signedInAs")}
        </span>
        <span className="text-sm font-medium truncate" dir="ltr">
          {email}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleSignOut}
        className="shrink-0 gap-1.5"
      >
        <LogOut className="h-4 w-4" />
        <span className="hidden sm:inline">{tAuth("signOut")}</span>
      </Button>
    </div>
  );
}
