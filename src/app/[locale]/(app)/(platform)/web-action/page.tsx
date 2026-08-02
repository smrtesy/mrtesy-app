export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { WebActionViewer } from "@/components/web-action/WebActionViewer";

export default async function WebActionPage() {
  const t = await getTranslations("webAction");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <WebActionViewer />
    </div>
  );
}
