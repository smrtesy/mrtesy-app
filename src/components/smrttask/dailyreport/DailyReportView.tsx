"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api/client";
import { useDayTool } from "@/hooks/useDayTools";
import { rangeLabel } from "@/lib/smrttask/dailyreport-dates";
import type { DailyReport, DailyReportRun, ReportItemResult, ReportTasks } from "@/types/daily-report";

/** Shared body: overall score + questions grouped by segment + tasks section. */
function ReportBody({
  items,
  tasks,
  overallScore,
}: {
  items: ReportItemResult[];
  tasks: ReportTasks;
  overallScore: number | null;
}) {
  const t = useTranslations("dailyReport");
  // Runs snapshotted before segments shipped have no `segment` → treat as start
  // (the default), so their questions still render instead of vanishing.
  const end = items.filter((i) => i.segment === "end");
  const start = items.filter((i) => i.segment !== "end");

  const group = (label: string, list: ReportItemResult[]) =>
    list.length === 0 ? null : (
      <div className="space-y-2">
        <div className="text-xs font-semibold text-muted-foreground">{label}</div>
        {list.map((it) => (
          <div key={it.item_id} className="rounded-md border p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium" dir="auto">{it.label}</span>
              {it.avg_score != null && (
                <span className="text-xs text-muted-foreground">
                  {t("avgScore")}: {it.avg_score}
                </span>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {it.options.map((o) => (
                <span
                  key={o.label}
                  dir="auto"
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs"
                >
                  {o.label}
                  <span className="font-semibold">{o.count}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );

  const fmtDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    if (h && m) return t("hoursMinutes", { h, m });
    if (h) return t("hoursOnly", { h });
    return t("minutesOnly", { m });
  };

  return (
    <div className="space-y-4">
      {overallScore != null && (
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-muted-foreground">{t("overallScore")}</span>
          <span className="text-2xl font-bold">{overallScore}</span>
        </div>
      )}
      {group(t("segmentEnd"), end)}
      {group(t("segmentStart"), start)}

      <div className="space-y-1.5">
        <div className="text-xs font-semibold text-muted-foreground">{t("tasksSection")}</div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <span className="rounded-full bg-muted px-2 py-0.5">{t("sizeQuick")}: {tasks.quick}</span>
          <span className="rounded-full bg-muted px-2 py-0.5">{t("sizeMedium")}: {tasks.medium}</span>
          <span className="rounded-full bg-muted px-2 py-0.5">{t("sizeBig")}: {tasks.big}</span>
          <span className="rounded-full bg-muted px-2 py-0.5">{t("workedTime")}: {fmtDuration(tasks.worked_seconds)}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The "דוחות" tab of the dedicated screen: a live preview of the current
 * period, a "generate now → inbox" action, and the history of generated runs.
 */
export function DailyReportView() {
  const t = useTranslations("dailyReport");
  const { config } = useDayTool("dailyreport");
  const period = typeof config.period === "string" ? config.period : "weekly";

  const [preview, setPreview] = useState<DailyReport | null>(null);
  const [runs, setRuns] = useState<DailyReportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, r] = await Promise.all([
        api<{ report: DailyReport }>(`/api/daily-report/preview?period=${period}`),
        api<{ runs: DailyReportRun[] }>("/api/daily-report/runs"),
      ]);
      setPreview(p.report);
      setRuns(r.runs ?? []);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [period, t]);

  useEffect(() => {
    load();
  }, [load]);

  const generateNow = useCallback(async () => {
    setGenerating(true);
    try {
      await api("/api/daily-report/generate", { method: "POST", body: { period } });
      toast.success(t("generatedToInbox"));
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("generateError"));
    } finally {
      setGenerating(false);
    }
  }, [period, t, load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("loading")}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Current period preview */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <div>
            <CardTitle className="text-base">{t("currentPeriodTitle")}</CardTitle>
            {preview && (
              <p className="text-xs text-muted-foreground">
                {rangeLabel(preview.range_start, preview.range_end)}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={load} className="gap-1 text-xs" aria-label={t("refresh")}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" onClick={generateNow} disabled={generating} className="gap-1 text-xs">
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {t("generateNow")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {preview && preview.items.length === 0 && preview.tasks.worked_seconds === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground" dir="auto">{t("emptyPeriod")}</p>
          ) : preview ? (
            <ReportBody items={preview.items} tasks={preview.tasks} overallScore={preview.overall_score} />
          ) : null}
        </CardContent>
      </Card>

      {/* History */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">{t("historyTitle")}</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted-foreground" dir="auto">{t("historyEmpty")}</p>
        ) : (
          runs.map((run) => (
            <Card key={run.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">
                  {rangeLabel(run.range_start, run.range_end)}
                </CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  {run.generated_by === "schedule" ? t("bySchedule") : t("byManual")}
                </p>
              </CardHeader>
              <CardContent>
                <ReportBody
                  items={run.breakdown?.items ?? []}
                  tasks={run.breakdown?.tasks ?? { quick: 0, medium: 0, big: 0, worked_seconds: 0 }}
                  overallScore={run.overall_score}
                />
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
