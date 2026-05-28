import { getTranslations } from "next-intl/server";
import { SettingsTabs } from "@/components/platform/settings/SettingsTabs";
import { getEnabledAppsForActiveOrg } from "@/lib/apps/server";

export default async function AppSettingsRootPage({
  params,
}: {
  params: Promise<{ locale: string; appSlug: string }>;
}) {
  const { appSlug } = await params;
  const t = await getTranslations("settings");
  const enabledApps = await getEnabledAppsForActiveOrg();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-start">{t("title")}</h1>
      <SettingsTabs enabledApps={enabledApps} appSlug={appSlug} />
    </div>
  );
}
