import { getTranslations } from "next-intl/server";
import { SettingsTabs } from "@/components/platform/settings/SettingsTabs";
import { getEnabledAppsForActiveOrg } from "@/lib/apps/server";

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  const enabledApps = await getEnabledAppsForActiveOrg();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>
      <SettingsTabs enabledApps={enabledApps} />
    </div>
  );
}
