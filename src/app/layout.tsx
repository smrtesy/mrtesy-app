import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "smrtesy — Smart & Easy",
  description: "Personal AI Brain",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const heads = await headers();
  const locale = heads.get("x-next-intl-locale") ?? "he";
  const dir = locale === "he" ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  );
}
