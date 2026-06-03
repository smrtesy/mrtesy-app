"use client";

import { useTranslations } from "next-intl";
import { SmrtBotIcon } from "@/components/icons/SmrtBotIcon";

/**
 * Phase-0 placeholder for the bots management screen. The real screen
 * (create bot, edit basic details, live/test WhatsApp credentials) lands in a
 * later phase once the smrtbot_* schema exists.
 */
export function BotsClient() {
  const t = useTranslations("smrtBot");

  return (
    <div className="rounded-lg border border-border bg-card p-8 text-center">
      <SmrtBotIcon className="mx-auto h-10 w-10 text-muted-foreground" />
      <p className="mt-3 text-muted-foreground">{t("emptyState")}</p>
    </div>
  );
}
