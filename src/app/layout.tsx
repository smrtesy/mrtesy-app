import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Heebo } from "next/font/google";
import { ServiceWorkerRegistrar } from "@/components/pwa/ServiceWorkerRegistrar";
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
  applicationName: "smrtesy",
  // Drives the installable PWA — display:standalone removes the address bar.
  manifest: "/manifest.webmanifest",
  // iOS standalone meta tags: launch chrome-less from the home screen.
  appleWebApp: {
    capable: true,
    title: "smrtesy",
    statusBarStyle: "default",
  },
  // Stop iOS from auto-linking digit strings as phone numbers in the app.
  formatDetection: { telephone: false },
  // Real PNG files (static, not the dynamic /api/icon route) — iOS grabs the
  // apple-touch-icon at add-to-home-screen time and a dynamic route can render
  // as a blank white icon. icon[] also gives Android/desktop a PNG favicon.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-icon-180.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAFAF7" },
    { media: "(prefers-color-scheme: dark)", color: "#1C1B1A" },
  ],
  width: "device-width",
  initialScale: 1,
  // Lock zoom for a native app feel and to kill the iOS focus-zoom jump.
  maximumScale: 1,
  userScalable: false,
  // Let the app paint into the notch / safe areas.
  viewportFit: "cover",
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
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
