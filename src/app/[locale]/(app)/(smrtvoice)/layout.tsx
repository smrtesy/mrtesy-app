import { requireAppAccess } from "@/lib/apps/guard";

// The absorbed smrtVoice screens live on their own URLs but are entitled by
// smrtStudio (stage G), so they gate on that slug.

/**
 * Entitlement guard for this app's screens. A user who was never granted
 * "smrtstudio" is sent to a screen they can actually open, instead of rendering a
 * surface whose every API call the backend refuses. See lib/apps/guard.ts.
 */
export default async function AppGroupLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  await requireAppAccess("smrtstudio", locale);
  return <>{children}</>;
}
