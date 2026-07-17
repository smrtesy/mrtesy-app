export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { InfoClient } from "@/components/smrtinfo/InfoClient";

export default async function InfoPage() {
  const t = await getTranslations("smrtInfo");

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <InfoClient />
    </div>
  );
}
