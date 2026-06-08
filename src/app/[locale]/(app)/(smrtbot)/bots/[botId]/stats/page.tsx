export const dynamic = "force-dynamic";

import { StatsClient } from "@/components/smrtbot/StatsClient";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotStatsPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="stats" />
      <StatsClient botId={botId} />
    </div>
  );
}
