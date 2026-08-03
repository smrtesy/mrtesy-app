import { PermissionsCatalogClient } from "@/components/admin/PermissionsCatalogClient";

export default async function AdminPermissionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return <PermissionsCatalogClient />;
}
