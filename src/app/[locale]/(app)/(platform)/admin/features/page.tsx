import { FeaturesClient } from "@/components/admin/FeaturesClient";

export default async function AdminFeaturesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  await params;
  return <FeaturesClient />;
}
