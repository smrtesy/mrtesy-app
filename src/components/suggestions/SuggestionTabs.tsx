"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSuggestions } from "./MessageSuggestions";
import { ScheduledSuggestions } from "./ScheduledSuggestions";
import { ProjectSuggestions } from "./ProjectSuggestions";
import { Bell, Calendar, Lightbulb } from "lucide-react";

export function SuggestionTabs({ locale }: { locale: string }) {
  const t = useTranslations("suggestions");
  const [activeTab, setActiveTab] = useState("messages");

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <TabsList className="w-full">
        <TabsTrigger value="messages" className="flex-1 gap-1">
          <Bell className="h-4 w-4" />
          <span className="hidden sm:inline">{t("tabs.messages")}</span>
        </TabsTrigger>
        <TabsTrigger value="scheduled" className="flex-1 gap-1">
          <Calendar className="h-4 w-4" />
          <span className="hidden sm:inline">{t("tabs.scheduled")}</span>
        </TabsTrigger>
        <TabsTrigger value="projects" className="flex-1 gap-1">
          <Lightbulb className="h-4 w-4" />
          <span className="hidden sm:inline">{t("tabs.projects")}</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="messages" className="mt-4">
        <MessageSuggestions locale={locale} />
      </TabsContent>
      <TabsContent value="scheduled" className="mt-4">
        <ScheduledSuggestions locale={locale} />
      </TabsContent>
      <TabsContent value="projects" className="mt-4">
        <ProjectSuggestions locale={locale} />
      </TabsContent>
    </Tabs>
  );
}
