"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api/client";

interface Insights {
  days: number;
  sessions: number;
  avg_worked_seconds: number;
  avg_quick_seconds: number;
  avg_medium_seconds: number;
  avg_big_seconds: number;
}

/** Compact learning summary for the workclock (docs/workclock-plan.md §7.4).
 *  Shown in the day-tools settings panel when the tool is on. */
export function WorkClockInsights() {
  const t = useTranslations("workclock");
  const [data, setData] = useState<Insights | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<Insights>("/api/tasks/work-clock/insights?days=30")
      .then(setData)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;
  if (!data || data.sessions === 0) {
    return <p className="text-xs text-muted-foreground" dir="auto">{t("insightsNone")}</p>;
  }

  const hm = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return (
    <div className="space-y-1 rounded-lg border bg-muted/20 p-3 text-xs">
      <p className="font-semibold text-foreground" dir="auto">{t("insightsTitle", { days: data.days })}</p>
      <p className="text-muted-foreground" dir="auto">{t("insightsAvgDay", { time: hm(data.avg_worked_seconds), n: data.sessions })}</p>
      <p className="text-muted-foreground" dir="auto">
        {t("insightsPerSize", { q: hm(data.avg_quick_seconds), m: hm(data.avg_medium_seconds), b: hm(data.avg_big_seconds) })}
      </p>
    </div>
  );
}
