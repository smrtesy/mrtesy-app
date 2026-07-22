"use client";

import { useTranslations } from "next-intl";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DailyReportQuestions } from "@/components/smrttask/dailyreport/DailyReportQuestions";
import { DailyReportView } from "@/components/smrttask/dailyreport/DailyReportView";

/**
 * The dedicated דוח יומי screen (opens as its own pane / route). Two tabs:
 * "דוחות" (view + history + generate) and "הגדרות" (the question editor). Kept
 * off the compact day-tools settings section per the CLAUDE.md UI principle —
 * settings shows only the toggle + a button that opens this screen.
 */
export function DailyReportClient() {
  const t = useTranslations("dailyReport");
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold">{t("screenTitle")}</h1>
        <p className="text-sm text-muted-foreground" dir="auto">{t("screenSubtitle")}</p>
      </div>

      <Tabs defaultValue="reports">
        <TabsList>
          <TabsTrigger value="reports">{t("tabReports")}</TabsTrigger>
          <TabsTrigger value="questions">{t("tabQuestions")}</TabsTrigger>
        </TabsList>
        <TabsContent value="reports" className="mt-4">
          <DailyReportView />
        </TabsContent>
        <TabsContent value="questions" className="mt-4">
          <DailyReportQuestions />
        </TabsContent>
      </Tabs>
    </div>
  );
}
