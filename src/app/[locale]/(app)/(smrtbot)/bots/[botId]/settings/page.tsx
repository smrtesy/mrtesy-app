export const dynamic = "force-dynamic";

import { BotAiSettings } from "@/components/smrtbot/BotAiSettings";
import { SettingsPanel } from "@/components/smrtbot/SettingsPanel";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="settings" />
      <BotAiSettings botId={botId} />
      <SettingsPanel botId={botId} />
    </div>
  );
}
