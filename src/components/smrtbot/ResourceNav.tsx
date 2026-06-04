"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { RESOURCE_ORDER } from "./resourceConfigs";

/** Tab-style nav across a bot's content/game resources. */
export function ResourceNav({ botId, active }: { botId: string; active?: string }) {
  const t = useTranslations("smrtBot");
  const locale = useLocale();
  const label = (r: string) => (t.has(`res_${r}`) ? t(`res_${r}`) : r);

  return (
    <div className="flex flex-wrap gap-1 border-b border-border pb-2">
      <Link
        href={`/${locale}/bots/${botId}`}
        className={cn(
          "rounded-md px-3 py-1.5 text-sm hover:bg-muted",
          !active ? "bg-accent text-accent-foreground" : "text-muted-foreground",
        )}
      >
        {t("tabBasic")}
      </Link>
      {RESOURCE_ORDER.map((r) => (
        <Link
          key={r}
          href={`/${locale}/bots/${botId}/${r}`}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm hover:bg-muted",
            active === r ? "bg-accent text-accent-foreground" : "text-muted-foreground",
          )}
        >
          {label(r)}
        </Link>
      ))}
      {(["stats", "logs", "settings"] as const).map((r) => (
        <Link
          key={r}
          href={`/${locale}/bots/${botId}/${r}`}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm hover:bg-muted",
            active === r ? "bg-accent text-accent-foreground" : "text-muted-foreground",
          )}
        >
          {r === "stats" ? t("statsTitle") : r === "logs" ? t("logsTitle") : t("settingsTitle")}
        </Link>
      ))}
    </div>
  );
}
