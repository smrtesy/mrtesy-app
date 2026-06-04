export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { SettingsPanel } from "@/components/smrtbot/SettingsPanel";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotSettingsPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="settings" />
      <h1 className="text-2xl font-bold">{t("settingsTitle")}</h1>
      <SettingsPanel botId={botId} />
    </div>
  );
}
