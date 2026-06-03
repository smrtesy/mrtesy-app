export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { ContactsClient } from "@/components/smrtcrm/ContactsClient";

export default async function CrmPage() {
  const t = await getTranslations("smrtCRM");

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <ContactsClient />
    </div>
  );
}
