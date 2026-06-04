export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { BotEditForm } from "@/components/smrtbot/BotEditForm";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotDetailPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">{t("editBot")}</h1>
      <ResourceNav botId={botId} />
      <BotEditForm botId={botId} />
    </div>
  );
}
