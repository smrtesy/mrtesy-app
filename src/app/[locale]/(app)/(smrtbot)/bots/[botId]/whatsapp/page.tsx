export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { WhatsAppChannel } from "@/components/smrtbot/WhatsAppChannel";
import { ResourceNav } from "@/components/smrtbot/ResourceNav";

export default async function BotWhatsAppPage({
  params,
}: {
  params: Promise<{ locale: string; botId: string }>;
}) {
  const { botId } = await params;
  const t = await getTranslations("smrtBot");
  return (
    <div className="space-y-4 p-6">
      <ResourceNav botId={botId} active="whatsapp" />
      <h1 className="text-2xl font-bold">{t("waTitle")}</h1>
      <WhatsAppChannel botId={botId} />
    </div>
  );
}
