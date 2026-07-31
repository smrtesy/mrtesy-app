import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { RTLProvider } from "@/components/RTLProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MergeJobShell } from "@/components/MergeJobShell";
import { PWAInstallPrompt } from "@/components/pwa/PWAInstallPrompt";
import { Toaster } from "sonner";

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages();
  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <NextIntlClientProvider messages={messages}>
      {/* Radix primitives read direction from this context, not the html
          dir attribute — without it ScrollArea/Sheet/etc. silently fall
          back to LTR and inner flex rows render left-to-right on /he. */}
      <RTLProvider dir={dir}>
        <TooltipProvider>
          <MergeJobShell locale={locale}>
            {children}
          </MergeJobShell>
          <PWAInstallPrompt />
          {/* duration: system messages stay 10s before auto-closing (user standing
              preference, 2026-07). A few call sites pass their own duration and
              keep it (InstallAppButton 8s; smrtplan consult toasts already 10s).
              The undo countdown toast is unaffected (duration: Infinity, own 5s ring). */}
          <Toaster position={dir === "rtl" ? "top-left" : "top-right"} duration={10_000} />
        </TooltipProvider>
      </RTLProvider>
    </NextIntlClientProvider>
  );
}
