export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { WhatsAppPageClient } from "@/components/smrttask/whatsapp/WhatsAppPageClient";

export default async function WhatsAppPage() {
  // Server-side translation pre-fetch forces the next-intl manifest to
  // include this page's keys at build time.
  const t = await getTranslations("whatsappPage");
  return <WhatsAppPageClient title={t("title")} />;
}
