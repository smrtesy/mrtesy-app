import { PlanBoardClient } from "@/components/smrtplan/PlanBoardClient";

export const dynamic = "force-dynamic";

export default async function PlanBoardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <PlanBoardClient locale={locale} />;
}
