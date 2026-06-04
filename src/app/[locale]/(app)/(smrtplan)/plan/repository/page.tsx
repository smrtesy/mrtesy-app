import { PlanRepositoryClient } from "@/components/smrtplan/PlanRepositoryClient";

export const dynamic = "force-dynamic";

export default async function PlanRepositoryPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <PlanRepositoryClient locale={locale} />;
}
