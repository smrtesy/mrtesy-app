export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { LogsClient } from "@/components/smrtbot/LogsClient";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotLogsPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="logs" />
      <h1 className="text-2xl font-bold">{t("logsTitle")}</h1>
      <LogsClient botId={botId} />
    </div>
  );
}
