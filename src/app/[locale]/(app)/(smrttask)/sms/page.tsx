import { getTranslations } from "next-intl/server";
import { SmsPageClient } from "@/components/smrttask/sms/SmsPageClient";

export default async function SmsPage() {
  const t = await getTranslations("smsPage");
  return <SmsPageClient title={t("title")} />;
}
