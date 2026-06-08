export const dynamic = "force-dynamic";

import { BotEditForm } from "@/components/smrtbot/BotEditForm";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotDetailPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;

  return (
    <div className="p-6 space-y-4">
      <ResourceNav botId={botId} />
      <BotEditForm botId={botId} />
    </div>
  );
}
