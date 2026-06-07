export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { WebChatSettings } from "@/components/smrtbot/WebChatSettings";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotWebPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="web" />
      <h1 className="text-2xl font-bold">{t("webTitle")}</h1>
      <WebChatSettings botId={botId} />
    </div>
  );
}
