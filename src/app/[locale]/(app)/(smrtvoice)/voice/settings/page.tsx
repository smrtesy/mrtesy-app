import { getTranslations } from "next-intl/server";
import { SettingsForm } from "@/components/smrtvoice/SettingsForm";

export default async function VoiceSettingsPage() {
  const t = await getTranslations("smrtVoice");
  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold">{t("settings.title")}</h1>
      <SettingsForm />
    </div>
  );
}
