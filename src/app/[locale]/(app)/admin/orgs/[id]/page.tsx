import { OrgDetailClient } from "@/components/admin/OrgDetailClient";

export default async function AdminOrgDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  return <OrgDetailClient locale={locale} orgId={id} />;
}
