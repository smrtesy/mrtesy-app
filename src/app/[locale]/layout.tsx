import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";

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
    <div lang={locale} dir={dir}>
      <NextIntlClientProvider messages={messages}>
        <TooltipProvider>
          {children}
          <Toaster position={dir === "rtl" ? "top-left" : "top-right"} />
        </TooltipProvider>
      </NextIntlClientProvider>
    </div>
  );
}
