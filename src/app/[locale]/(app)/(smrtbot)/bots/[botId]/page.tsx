export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { BotEditForm } from "@/components/smrtbot/BotEditForm";

export default async function BotDetailPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">{t("editBot")}</h1>
      <BotEditForm botId={botId} />
    </div>
  );
}
