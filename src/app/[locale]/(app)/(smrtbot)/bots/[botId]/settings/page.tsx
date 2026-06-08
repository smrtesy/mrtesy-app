export const dynamic = "force-dynamic";

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
      <SettingsPanel botId={botId} />
    </div>
  );
}
