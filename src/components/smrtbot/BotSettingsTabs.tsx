"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BotEditForm } from "./BotEditForm";
import { WhatsAppTab } from "./WhatsAppTab";
import { SettingsPanel } from "./SettingsPanel";

/** The bot's configuration hub: identity, WhatsApp connection, and the
 *  advanced key/value settings — all under one "Settings" screen. */
export function BotSettingsTabs({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  return (
    <Tabs defaultValue="general">
      <TabsList>
        <TabsTrigger value="general">{t("tabBasic")}</TabsTrigger>
        <TabsTrigger value="whatsapp">{t("waTab")}</TabsTrigger>
        <TabsTrigger value="advanced">{t("settingsAdvanced")}</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="pt-4">
        <BotEditForm botId={botId} />
      </TabsContent>
      <TabsContent value="whatsapp" className="pt-4">
        <WhatsAppTab botId={botId} />
      </TabsContent>
      <TabsContent value="advanced" className="pt-4">
        <SettingsPanel botId={botId} />
      </TabsContent>
    </Tabs>
  );
}
