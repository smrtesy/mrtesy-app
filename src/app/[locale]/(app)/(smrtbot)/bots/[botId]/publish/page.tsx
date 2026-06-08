export const dynamic = "force-dynamic";

import { PublishClient } from "@/components/smrtbot/PublishClient";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotPublishPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="publish" />
      <PublishClient botId={botId} />
    </div>
  );
}
