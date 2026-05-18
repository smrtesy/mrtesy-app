"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SuggestionTabs } from "@/components/smrttask/suggestions/SuggestionTabs";
import { NotificationsList } from "@/components/platform/inbox/NotificationsList";
import { cn } from "@/lib/utils";

interface Props {
  locale: string;
  hasSmrtTask: boolean;
}

export function InboxTabs({ locale, hasSmrtTask }: Props) {
  const t = useTranslations("inbox");
  const [tab, setTab] = useState<"suggestions" | "notifications">(
    hasSmrtTask ? "suggestions" : "notifications",
  );

  return (
    <div className="space-y-4">
      {hasSmrtTask && (
        <div className="flex gap-1 border-b">
          <button
            onClick={() => setTab("suggestions")}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === "suggestions"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("tabSuggestions")}
          </button>
          <button
            onClick={() => setTab("notifications")}
            className={cn(
              "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
              tab === "notifications"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("tabNotifications")}
          </button>
        </div>
      )}

      {tab === "suggestions" && hasSmrtTask && (
        <SuggestionTabs locale={locale} />
      )}

      {tab === "notifications" && (
        <NotificationsList />
      )}
    </div>
  );
}
