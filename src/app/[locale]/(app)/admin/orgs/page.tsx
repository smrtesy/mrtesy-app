import { OrgsListClient } from "@/components/admin/OrgsListClient";

export default async function AdminOrgsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <OrgsListClient locale={locale} />;
}
