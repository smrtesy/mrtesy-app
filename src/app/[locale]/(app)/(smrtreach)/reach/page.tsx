export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { CampaignsClient } from "@/components/smrtreach/CampaignsClient";

export default async function ReachPage() {
  const t = await getTranslations("smrtReach");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <CampaignsClient />
    </div>
  );
}
