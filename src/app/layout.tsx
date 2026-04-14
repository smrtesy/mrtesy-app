// Root layout — Next.js requires <html> and <body> here
// The [locale]/layout.tsx overrides these with proper lang/dir attributes
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
