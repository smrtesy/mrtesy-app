"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSuggestions } from "./MessageSuggestions";
import { ScheduledSuggestions } from "./ScheduledSuggestions";
import { ProjectSuggestions } from "./ProjectSuggestions";
import { DismissedSuggestions } from "./DismissedSuggestions";
import { Bell, Calendar, Lightbulb, Trash2 } from "lucide-react";
import type { InboxCounts } from "@/components/platform/inbox/InboxTabs";

function TabCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ms-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function SuggestionTabs({
  locale,
  counts,
  onCountsChange,
}: {
  locale: string;
  counts: InboxCounts;
  onCountsChange: () => void;
}) {
  const t = useTranslations("suggestions");
  const [activeTab, setActiveTab] = useState("messages");

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} dir={locale === "he" ? "rtl" : "ltr"}>
      <TabsList className="w-full">
        <TabsTrigger value="messages" className="flex-1 gap-1">
          <Bell className="h-4 w-4" />
          <span className="text-xs sm:text-sm">{t("tabs.messages")}</span>
          <TabCount count={counts.messages} />
        </TabsTrigger>
        <TabsTrigger value="scheduled" className="flex-1 gap-1">
          <Calendar className="h-4 w-4" />
          <span className="text-xs sm:text-sm">{t("tabs.scheduled")}</span>
          <TabCount count={counts.scheduled} />
        </TabsTrigger>
        <TabsTrigger value="projects" className="flex-1 gap-1">
          <Lightbulb className="h-4 w-4" />
          <span className="text-xs sm:text-sm">{t("tabs.projects")}</span>
          <TabCount count={counts.projects} />
        </TabsTrigger>
        <TabsTrigger value="dismissed" className="flex-1 gap-1">
          <Trash2 className="h-4 w-4" />
          <span className="text-xs sm:text-sm">{t("tabs.dismissed")}</span>
          <TabCount count={counts.dismissed} />
        </TabsTrigger>
      </TabsList>

      <TabsContent value="messages" className="mt-4">
        <MessageSuggestions locale={locale} onUpdate={onCountsChange} />
      </TabsContent>
      <TabsContent value="scheduled" className="mt-4">
        <ScheduledSuggestions locale={locale} />
      </TabsContent>
      <TabsContent value="projects" className="mt-4">
        <ProjectSuggestions locale={locale} />
      </TabsContent>
      <TabsContent value="dismissed" className="mt-4">
        <DismissedSuggestions locale={locale} onChange={onCountsChange} />
      </TabsContent>
    </Tabs>
  );
}
