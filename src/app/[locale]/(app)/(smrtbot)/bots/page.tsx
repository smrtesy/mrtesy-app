export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { BotsClient } from "@/components/smrtbot/BotsClient";

export default async function BotsPage() {
  const t = await getTranslations("smrtBot");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <BotsClient />
    </div>
  );
}
