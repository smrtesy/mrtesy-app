import { SuperAdminsClient } from "@/components/admin/SuperAdminsClient";

export default async function AdminSuperAdminsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return <SuperAdminsClient />;
}
