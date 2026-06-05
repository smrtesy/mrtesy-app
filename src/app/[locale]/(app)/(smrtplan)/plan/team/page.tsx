import { TeamViewClient } from "@/components/smrtplan/TeamViewClient";

export const dynamic = "force-dynamic";

export default async function PlanTeamPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  return <TeamViewClient locale={locale} />;
}
