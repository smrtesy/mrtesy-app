export const dynamic = "force-dynamic";

import { WebChatSettings } from "@/components/smrtbot/WebChatSettings";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotWebPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="web" />
      <WebChatSettings botId={botId} />
    </div>
  );
}
