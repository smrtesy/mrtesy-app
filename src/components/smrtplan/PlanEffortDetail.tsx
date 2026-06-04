"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, Clock } from "lucide-react";
import { api } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import type { Plan } from "@/types/plan";
import type { Task, TaskNeed, TaskHandoff } from "@/types/task";
import { parseISO, gregShort, hebDate, countdownText, urgencyFor } from "@/lib/smrtplan/dates";

type PlanTask = Pick<
  Task,
  "id" | "title" | "title_he" | "status" | "due_date" | "latest_finish" | "is_critical"
> & { needs: TaskNeed[]; handoff: TaskHandoff[] };

function taskTitle(t: PlanTask, locale: string) {
  return locale === "en" ? t.title : t.title_he || t.title;
}

/** Ready when every "need" is satisfied; blocked when some input is still waiting. */
function zoneOf(t: PlanTask): "done" | "blocked" | "ready" {
  if (t.status === "archived" || t.status === "completed") return "done";
  if ((t.needs ?? []).some((n) => !n.satisfied)) return "blocked";
  return "ready";
}

const countdownClasses: Record<string, string> = {
  far: "bg-status-ok-bg text-status-ok",
  soon: "bg-status-warn-bg text-status-warn",
  urgent: "bg-status-late-bg text-status-late",
};

export function PlanEffortDetail({
  plan,
  locale,
  today,
}: {
  plan: Plan;
  locale: string;
  today: Date;
}) {
  const t = useTranslations("smrtPlan");
  const [tasks, setTasks] = useState<PlanTask[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{ tasks: PlanTask[] }>(`/api/plans/${plan.id}/tasks`);
        if (alive) setTasks(data.tasks ?? []);
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [plan.id]);

  const title = locale === "en" ? plan.title_en || plan.title_he : plan.title_he;
  const progress = plan.effective_progress ?? plan.progress ?? 0;

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-muted" />;

  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-bold">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: plan.color || "#534AB7" }} />
        {title}
      </h2>
      <p className="mb-3 mt-0.5 text-[12.5px] text-muted-foreground">
        {plan.goal ? `${plan.goal} · ` : ""}
        {plan.start_date && plan.end_date
          ? `${gregShort(parseISO(plan.start_date))}–${gregShort(parseISO(plan.end_date))} · `
          : ""}
        {Math.round(progress * 100)}%
      </p>

      {tasks.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] italic text-muted-foreground">{t("effort.empty")}</p>
      ) : (
        <div className="divide-y">
          {tasks.map((task) => {
            const zone = zoneOf(task);
            const due = task.latest_finish || task.due_date;
            const urg = urgencyFor(due, today);
            const waiting = (task.needs ?? []).filter((n) => !n.satisfied);
            return (
              <div key={task.id} className="py-2.5">
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded border text-[11px]",
                      zone === "done" && "border-status-ok bg-status-ok text-white",
                      zone === "blocked" && "border-dashed border-muted-foreground/40 text-transparent",
                      zone === "ready" && "border-muted-foreground/40",
                    )}
                  >
                    {zone === "done" ? "✓" : ""}
                  </span>
                  <span
                    className={cn(
                      "flex-1 text-[13px]",
                      zone === "done" && "text-muted-foreground line-through",
                    )}
                  >
                    {taskTitle(task, locale)}
                    {task.is_critical && (
                      <span className="ms-2 rounded bg-status-late-bg px-1.5 py-px text-[9px] font-bold text-status-late">
                        {t("tags.critical")}
                      </span>
                    )}
                  </span>
                  {due && zone !== "done" && (
                    <span
                      className={cn(
                        "whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-bold",
                        urg ? countdownClasses[urg] : "bg-secondary text-muted-foreground",
                      )}
                    >
                      {countdownText(due, t, today)} · {gregShort(parseISO(due))} · {hebDate(parseISO(due))}
                    </span>
                  )}
                </div>

                {/* needs */}
                {zone === "blocked" && waiting.length > 0 && (
                  <div className="ms-7 mt-1.5 space-y-1">
                    <div className="text-[11px] font-bold text-muted-foreground">{t("effort.needs")}</div>
                    {(task.needs ?? []).map((n) => (
                      <div key={n.dependency_id} className="flex items-center gap-2 text-[12px]">
                        <span
                          className={cn(
                            "flex h-[16px] w-[16px] items-center justify-center rounded text-[10px] text-white",
                            n.satisfied ? "bg-status-ok" : "bg-status-warn",
                          )}
                        >
                          {n.satisfied ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                        </span>
                        <span>{n.title}</span>
                        {n.source && <span className="text-[11px] text-muted-foreground">{n.source}</span>}
                        <span className="ms-auto text-[11px] text-muted-foreground">
                          {n.satisfied ? t("effort.arrived") : t("effort.waiting")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* handoff */}
                {(task.handoff ?? []).length > 0 && zone !== "done" && (
                  <div className="ms-7 mt-1 flex items-center gap-1.5 text-[12px] text-foreground/70">
                    <ArrowRight className="h-3.5 w-3.5 text-status-ok" />
                    <span className="text-[11px] font-bold text-muted-foreground">{t("effort.handoff")}:</span>
                    {(task.handoff ?? []).map((h) => h.title).join(" · ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
