export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { StatsClient } from "@/components/smrtbot/StatsClient";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotStatsPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="stats" />
      <h1 className="text-2xl font-bold">{t("statsTitle")}</h1>
      <StatsClient botId={botId} />
    </div>
  );
}
