import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { RTLProvider } from "@/components/RTLProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MergeJobShell } from "@/components/MergeJobShell";
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
          <Toaster position={dir === "rtl" ? "top-left" : "top-right"} />
        </TooltipProvider>
      </RTLProvider>
    </NextIntlClientProvider>
  );
}
