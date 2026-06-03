import type { Metadata } from "next";
import { headers } from "next/headers";
import { Heebo } from "next/font/google";
import "./globals.css";

// גופן יחיד למערכת — Heebo, שלושה משקלים בלבד (רגיל/בינוני/מודגש).
const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "700"],
  variable: "--font-heebo",
  display: "swap",
});

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
    <html lang={locale} dir={dir} className={heebo.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
