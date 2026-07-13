"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api/client";
import { TaskZones, type PlanZoneTask } from "./TaskZones";
import { TaskDetailDialog } from "./TaskDetailDialog";
import { DecisionDialog } from "@/components/smrttask/tasks/DecisionDialog";

export function MyTasksClient({ locale }: { locale: string }) {
  const t = useTranslations("smrtPlan");
  const [tasks, setTasks] = useState<PlanZoneTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [canEdit, setCanEdit] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [decisionTask, setDecisionTask] = useState<PlanZoneTask | null>(null);
  const today = new Date();

  const load = useCallback(async () => {
    const { tasks } = await api<{ tasks: PlanZoneTask[] }>("/api/plan/my-tasks");
    setTasks(tasks ?? []);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await load();
        const { access_level } = await api<{ access_level: string }>("/api/plans/access");
        if (alive) setCanEdit(access_level === "full");
      } catch (e) {
        if (alive) toast.error(e instanceof Error ? e.message : "Error");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // ✓ completes (releases dependents server-side); un-✓ reopens. The /done
  // endpoint is allowed for the task's assignee even without full access.
  // Completing a decision task first captures its outcome (propagated forward).
  async function toggle(id: string, done: boolean, decision?: string) {
    if (done && !decision) {
      const tk = tasks.find((x) => x.id === id);
      if (tk?.is_decision) { setDecisionTask(tk); return; }
    }
    setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, status: done ? "completed" : "inbox" } : x)));
    try {
      await api(`/api/plan-tasks/${id}/done`, { method: "PATCH", body: { done, ...(decision ? { decision } : {}) } });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error");
      await load();
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("my.title")}</h1>
        <p className="text-[12.5px] text-muted-foreground">{t("my.lead")}</p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center text-[12.5px] italic text-muted-foreground">
          {t("my.noTasks")}
        </div>
      ) : (
        <TaskZones
          tasks={tasks}
          locale={locale}
          today={today}
          onToggle={toggle}
          onOpen={(tk) => setOpenTaskId(tk.id)}
        />
      )}

      <TaskDetailDialog
        taskId={openTaskId}
        open={!!openTaskId}
        onClose={() => setOpenTaskId(null)}
        locale={locale}
        canEdit={canEdit}
        onChanged={() => void load()}
      />

      <DecisionDialog
        open={!!decisionTask}
        taskTitle={decisionTask ? (locale === "en" ? decisionTask.title : decisionTask.title_he || decisionTask.title) : ""}
        onClose={() => setDecisionTask(null)}
        onConfirm={(decision) => {
          const tk = decisionTask;
          setDecisionTask(null);
          if (tk) void toggle(tk.id, true, decision);
        }}
      />
    </div>
  );
}
