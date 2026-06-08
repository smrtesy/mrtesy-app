export const dynamic = "force-dynamic";

import { LogsClient } from "@/components/smrtbot/LogsClient";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotLogsPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="logs" />
      <LogsClient botId={botId} />
    </div>
  );
}
