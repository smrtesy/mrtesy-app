export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { RESOURCES } from "@/components/smrtbot/resourceConfigs";
import { ResourceManager } from "@/components/smrtbot/ResourceManager";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";
import { MenuView } from "@/components/smrtbot/MenuView";

export default async function BotResourcePage({
  params,
}: {
  params: Promise<{ locale: string; botId: string; resource: string }>;
}) {
  const { botId, resource } = await params;
  const config = RESOURCES[resource];
  if (!config) notFound();

  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active={resource} />
      {resource === "menu" ? (
        <MenuView botId={botId} />
      ) : (
        <ResourceManager botId={botId} config={config} />
      )}
    </div>
  );
}
