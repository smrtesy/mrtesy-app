import { OrgSettingsClient } from "@/components/org/OrgSettingsClient";

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <OrgSettingsClient locale={locale} />;
}
