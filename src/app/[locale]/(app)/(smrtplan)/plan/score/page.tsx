import { ExperimentScoring } from "@/components/smrtplan/ExperimentScoring";

export const dynamic = "force-dynamic";

export default async function PlanScorePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ plan_id?: string; test?: string }>;
}) {
  await params;
  const { plan_id, test } = await searchParams;
  return <ExperimentScoring planId={plan_id ?? null} testLabel={test ?? null} />;
}
