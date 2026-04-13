import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import "../globals.css";

export const metadata: Metadata = {
  title: "smrtesy — Smart & Easy",
  description: "Personal AI Brain",
};

export default async function LocaleLayout({
  children,
  params: { locale },
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  const messages = await getMessages();
  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen bg-background font-sans antialiased">
        <NextIntlClientProvider messages={messages}>
          <TooltipProvider>
            {children}
            <Toaster position={dir === "rtl" ? "top-left" : "top-right"} />
          </TooltipProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
