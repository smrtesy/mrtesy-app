import { AppsRegistryClient } from "@/components/admin/AppsRegistryClient";

export default async function AdminAppsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return <AppsRegistryClient />;
}
