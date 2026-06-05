"use client";

import { useTranslations } from "next-intl";
import { Zap, Hourglass, CheckCircle2, Clock, ArrowRight, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskNeed, TaskHandoff } from "@/types/task";
import { parseISO, gregShort, hebDate, countdownText, urgencyFor } from "@/lib/smrtplan/dates";

export interface PlanZoneTask {
  id: string;
  title: string;
  title_he: string | null;
  status: string;
  assigned_to_user_id: string | null;
  due_date: string | null;
  latest_finish: string | null;
  is_critical: boolean | null;
  plan_title_he: string | null;
  plan_title_en: string | null;
  needs: TaskNeed[];
  handoff: TaskHandoff[];
}

type Zone = "ready" | "blocked" | "done";

export function zoneOf(t: PlanZoneTask): Zone {
  if (t.status === "archived" || t.status === "completed" || t.status === "dismissed") return "done";
  if ((t.needs ?? []).some((n) => !n.satisfied)) return "blocked";
  return "ready";
}

const countdownClasses: Record<string, string> = {
  far: "bg-status-ok-bg text-status-ok",
  soon: "bg-status-warn-bg text-status-warn",
  urgent: "bg-status-late-bg text-status-late",
};

const ZONES: { key: Zone; icon: typeof Zap; cls: string }[] = [
  { key: "ready", icon: Zap, cls: "bg-status-ok-bg text-status-ok" },
  { key: "blocked", icon: Hourglass, cls: "bg-status-warn-bg text-status-warn" },
  { key: "done", icon: CheckCircle2, cls: "bg-secondary text-muted-foreground" },
];

/** The ready / blocked / done worker board — shared by "My tasks" and the
 *  by-worker view. `onComplete` enables the quick ✓ on ready tasks. */
export function TaskZones({
  tasks,
  locale,
  today,
  onComplete,
}: {
  tasks: PlanZoneTask[];
  locale: string;
  today: Date;
  onComplete?: (id: string) => void;
}) {
  const t = useTranslations("smrtPlan");
  const title = (tk: PlanZoneTask) => (locale === "en" ? tk.title : tk.title_he || tk.title);
  const planLabel = (tk: PlanZoneTask) => (locale === "en" ? tk.plan_title_en || tk.plan_title_he : tk.plan_title_he);

  return (
    <div className="space-y-5">
      {ZONES.map((z) => {
        const items = tasks.filter((tk) => zoneOf(tk) === z.key);
        return (
          <section key={z.key}>
            <div className="mb-2 flex items-center gap-2 px-1 text-[13px] font-bold">
              <span className={cn("flex h-5 w-5 items-center justify-center rounded-md", z.cls)}>
                <z.icon className="h-3.5 w-3.5" />
              </span>
              {t(`my.${z.key}`)}
              <span className="rounded-full bg-secondary px-2 text-[11px] font-medium text-muted-foreground">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <p className="px-2 text-[12px] italic text-muted-foreground">
                {t(`my.empty${z.key[0].toUpperCase()}${z.key.slice(1)}`)}
              </p>
            ) : (
              <div className="space-y-2">
                {items.map((tk) => {
                  const deadline = tk.due_date || tk.latest_finish || null;
                  const constraint =
                    tk.latest_finish && tk.due_date && tk.latest_finish < tk.due_date ? tk.latest_finish : null;
                  const urg = urgencyFor(deadline, today);
                  const waiting = (tk.needs ?? []).filter((n) => !n.satisfied);
                  return (
                    <div key={tk.id} className={cn("rounded-xl border bg-card p-3", z.key === "done" && "opacity-70")}>
                      <div className="flex items-center gap-2.5">
                        {z.key === "ready" && onComplete ? (
                          <button
                            onClick={() => onComplete(tk.id)}
                            title={t("my.complete")}
                            className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md border-2 border-muted-foreground/40 text-transparent hover:border-status-ok hover:text-status-ok"
                          >
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <span
                            className={cn(
                              "flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-md text-[12px]",
                              z.key === "done"
                                ? "border-2 border-status-ok bg-status-ok text-white"
                                : "border-2 border-dashed border-muted-foreground/40",
                            )}
                          >
                            {z.key === "done" ? "✓" : ""}
                          </span>
                        )}
                        <span className={cn("flex-1 text-[14px] font-medium", z.key === "done" && "text-muted-foreground line-through")}>
                          {title(tk)}
                          {tk.is_critical && (
                            <span className="ms-2 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                              {t("tags.critical")}
                            </span>
                          )}
                        </span>
                        {!tk.assigned_to_user_id && z.key !== "done" && (
                          <span className="whitespace-nowrap rounded bg-secondary px-2 py-0.5 text-[10.5px] text-muted-foreground">
                            {t("edit.unassigned")}
                          </span>
                        )}
                        {planLabel(tk) && (
                          <span className="whitespace-nowrap rounded bg-accent px-2 py-0.5 text-[10.5px] text-accent-foreground">
                            {planLabel(tk)}
                          </span>
                        )}
                        {deadline && z.key !== "done" && (
                          <span
                            className={cn(
                              "whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold",
                              urg ? countdownClasses[urg] : "bg-secondary text-muted-foreground",
                            )}
                          >
                            {countdownText(deadline, t, today)} · {gregShort(parseISO(deadline))} · {hebDate(parseISO(deadline))}
                            {constraint && <span className="ms-1 text-status-late">⚠ {gregShort(parseISO(constraint))}</span>}
                          </span>
                        )}
                      </div>

                      {z.key === "blocked" && waiting.length > 0 && (
                        <div className="ms-8 mt-1.5 space-y-1">
                          <div className="text-[11px] font-bold text-muted-foreground">{t("effort.needs")}</div>
                          {(tk.needs ?? []).map((n) => (
                            <div key={n.dependency_id} className="flex items-center gap-2 text-[12px]">
                              <span
                                className={cn(
                                  "flex h-[16px] w-[16px] items-center justify-center rounded text-white",
                                  n.satisfied ? "bg-status-ok" : "bg-status-warn",
                                )}
                              >
                                {n.satisfied ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                              </span>
                              <span>{n.title}</span>
                              <span className="ms-auto text-[11px] text-muted-foreground">
                                {n.satisfied ? t("effort.arrived") : t("effort.waiting")}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {(tk.handoff ?? []).length > 0 && z.key !== "done" && (
                        <div className="ms-8 mt-1 flex items-center gap-1.5 text-[12px] text-foreground/70">
                          <ArrowRight className="h-3.5 w-3.5 text-status-ok" />
                          <span className="text-[11px] font-bold text-muted-foreground">{t("effort.handoff")}:</span>
                          {(tk.handoff ?? []).map((h) => h.title).join(" · ")}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
