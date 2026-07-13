export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";

import { VoiceNav } from "@/components/smrtvoice/VoiceNav";
import { VoiceInsights } from "@/components/smrtvoice/VoiceInsights";

export default async function VoiceInsightsPage() {
  const t = await getTranslations("smrtVoice.insights");
  return (
    <div className="p-6 space-y-6">
      <VoiceNav />
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <VoiceInsights />
    </div>
  );
}
