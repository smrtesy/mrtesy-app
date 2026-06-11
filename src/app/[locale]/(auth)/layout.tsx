import Link from "next/link";

export default async function AuthLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const isHe = locale !== "en";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted px-4">
      <div className="flex flex-1 items-center justify-center">{children}</div>

      <footer className="w-full py-6 text-center text-xs text-muted-foreground">
        <div className="flex items-center justify-center gap-4">
          <Link
            href={`/${locale}/privacy`}
            className="hover:text-foreground hover:underline"
          >
            {isHe ? "מדיניות פרטיות" : "Privacy Policy"}
          </Link>
          <span>·</span>
          <Link
            href={`/${locale}/terms`}
            className="hover:text-foreground hover:underline"
          >
            {isHe ? "תנאי שימוש" : "Terms of Service"}
          </Link>
        </div>
      </footer>
    </div>
  );
}
