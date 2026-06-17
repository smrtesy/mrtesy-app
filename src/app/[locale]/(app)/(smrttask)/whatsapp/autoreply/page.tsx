export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { AutoReplyManager } from "@/components/smrttask/whatsapp/AutoReplyManager";

export default async function WhatsAppAutoReplyPage() {
  // Force the next-intl manifest to include this namespace at build time.
  await getTranslations("whatsappAutoreply");
  return <AutoReplyManager />;
}
