export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { DesignConsole } from "@/components/smrtdesign/DesignConsole";

export default async function DesignPage() {
  const t = await getTranslations("smrtDesign");

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <DesignConsole />
    </div>
  );
}
