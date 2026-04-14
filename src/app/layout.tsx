import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "smrtesy — Smart & Easy",
  description: "Personal AI Brain",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
