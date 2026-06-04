export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { PublishClient } from "@/components/smrtbot/PublishClient";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotPublishPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="publish" />
      <h1 className="text-2xl font-bold">{t("publishTitle")}</h1>
      <PublishClient botId={botId} />
    </div>
  );
}
