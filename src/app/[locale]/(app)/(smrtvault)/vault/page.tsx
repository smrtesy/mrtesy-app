export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { VaultClient } from "@/components/smrtvault/VaultClient";

export default async function VaultPage() {
  const t = await getTranslations("smrtVault");

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <VaultClient />
    </div>
  );
}
