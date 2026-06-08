export const dynamic = "force-dynamic";

import { WhatsAppTab } from "@/components/smrtbot/WhatsAppTab";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotWhatsAppPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="whatsapp" />
      <WhatsAppTab botId={botId} />
    </div>
  );
}
