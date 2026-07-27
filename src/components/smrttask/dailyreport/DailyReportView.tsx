"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarDays, Check, Loader2, Play, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api, ApiError } from "@/lib/api/client";
import { useDayTool } from "@/hooks/useDayTools";
import { dayLabel, rangeLabel } from "@/lib/smrttask/dailyreport-dates";
import { DailyReportCheckin } from "@/components/smrttask/dailyreport/DailyReportCheckin";
import type {
  DailyReport,
  DailyReportDays,
  DailyReportRun,
  ReportDay,
  ReportItemResult,
  ReportTasks,
} from "@/types/daily-report";

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

/** How many days back the "edit a previous day" list offers (server caps at 60). */
const EDIT_DAYS_SPAN = 30;

/**
 * The "דוחות" tab of the dedicated screen: a live preview of the current
 * period, a "generate now → inbox" action, the history of generated runs, and a
 * quiet (collapsed-by-default) editor for previous days' answers.
 */
export function DailyReportView() {
  const t = useTranslations("dailyReport");
  const { config } = useDayTool("dailyreport");
  const period = typeof config.period === "string" ? config.period : "weekly";

  const [preview, setPreview] = useState<DailyReport | null>(null);
  const [runs, setRuns] = useState<DailyReportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  // Past-day editing: collapsed by default (CLAUDE.md compact-UI principle) —
  // a calendar icon in the header expands the day list.
  const [daysOpen, setDaysOpen] = useState(false);
  const [days, setDays] = useState<ReportDay[]>([]);
  const [daysLoading, setDaysLoading] = useState(false);
  const [editDate, setEditDate] = useState<string | null>(null);

  /** `silent` refreshes without swapping the whole view for the spinner (used
   *  after a past-day edit, so the expanded day list doesn't flicker away). */
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
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
      if (!silent) setLoading(false);
    }
  }, [period, t]);

  useEffect(() => {
    load();
  }, [load]);

  const loadDays = useCallback(async () => {
    setDaysLoading(true);
    try {
      const r = await api<DailyReportDays>(`/api/daily-report/days?limit=${EDIT_DAYS_SPAN}`);
      setDays(r.days ?? []);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setDaysLoading(false);
    }
  }, [t]);

  const toggleDays = useCallback(() => {
    if (daysOpen) {
      setDaysOpen(false);
      return;
    }
    setDaysOpen(true);
    loadDays();
  }, [daysOpen, loadDays]);

  /** After editing a past day: refresh the day list AND the preview (an edited
   *  day inside the current period changes the tallies). */
  const onEditSaved = useCallback(() => {
    loadDays();
    load(true);
  }, [loadDays, load]);

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
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={toggleDays}
              className="gap-1 text-xs"
              aria-label={t("editPastTitle")}
              title={t("editPastTitle")}
              aria-expanded={daysOpen}
            >
              <CalendarDays className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => load()} className="gap-1 text-xs" aria-label={t("refresh")}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" size="sm" onClick={generateNow} disabled={generating} className="gap-1 text-xs">
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              {t("generateNow")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {/* Past-day editor — expanded on demand from the calendar icon above.
              Any day here is inside the server's edit window, so opening it and
              saving always succeeds. */}
          {daysOpen && (
            <div className="mb-4 rounded-md border bg-muted/30 p-2.5">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">{t("editPastTitle")}</div>
                  <p className="text-[11px] text-muted-foreground" dir="auto">{t("editPastNote")}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 p-0"
                  onClick={() => setDaysOpen(false)}
                  aria-label={t("cancel")}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              {daysLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("loading")}
                </div>
              ) : days.length === 0 ? (
                <p className="py-2 text-xs text-muted-foreground" dir="auto">{t("editPastEmpty")}</p>
              ) : (
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {days.map((d) => (
                    <button
                      key={d.fill_date}
                      type="button"
                      onClick={() => setEditDate(d.fill_date)}
                      className="flex w-full items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-1.5 text-start text-xs transition-colors hover:bg-accent"
                    >
                      <span className="truncate" dir="auto">
                        {d.is_today ? t("dayIsToday", { date: dayLabel(d.fill_date) }) : dayLabel(d.fill_date)}
                      </span>
                      {d.complete ? (
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-status-ok">
                          <Check className="h-3 w-3" />
                          {t("dayComplete")}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {t("dayProgress", { answered: d.answered, total: d.total_due })}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

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

      {/* The same check-in dialog the pinned row opens, here in edit mode: the
          server pre-fills the day's saved answers and a partial save is allowed. */}
      <DailyReportCheckin
        open={editDate != null}
        fillDate={editDate}
        allowPartialSave
        onClose={() => setEditDate(null)}
        onSaved={onEditSaved}
      />
    </div>
  );
}
